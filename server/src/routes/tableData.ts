import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import QueryStream from 'pg-query-stream';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { CellValue } from '../../../shared/types';
import type {
  CommitRequest, CommitResponse, CountResponse, ExportFormat, ExportParams, FilterCondition, ImportBatchRequest,
  ImportBatchResponse, ImportBeginRequest, ImportBeginResponse, RelKind, RowChange, RowsQuery, RowsRequest, RowsResponse,
  TableColumn, TableInfo, WriteValue,
} from '../../../shared/tableData';
import { getPool, queryRows, withClient } from '../db';
import { getConnection } from '../store';
import { HttpError, toQueryError } from '../lib/errors';
import { qualified, quoteIdent, quoteLiteral } from '../lib/sql';

/**
 * Table data: browse (filter / sort / page), count, staged edits (one transaction),
 * streaming export and transactional CSV import.
 *
 * Prefix: /api/c/:connId/db/:db/table-data/:schema/:table
 *
 * Safety: every value is a bind parameter, every identifier goes through quoteIdent()
 * and is validated against the catalog. Reads run inside READ ONLY transactions, so the
 * user-authored raw WHERE text can't modify data.
 */

type P = { connId: string; db: string; schema: string; table: string };
const BASE = '/api/c/:connId/db/:db/table-data/:schema/:table';

const REL_KIND: Record<string, RelKind> = { r: 'table', p: 'partitioned_table', v: 'view', m: 'materialized_view', f: 'foreign_table' };
const KIND_LABEL: Record<RelKind, string> = {
  table: 'table', partitioned_table: 'partitioned table', view: 'view', materialized_view: 'materialized view', foreign_table: 'foreign table',
};

// ---------------------------------------------------------------- catalog

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
}

export async function loadTableInfo(connId: string, db: string, schema: string, table: string): Promise<TableInfo> {
  const rel = (await queryRows(connId, db, `
    SELECT c.oid::int AS oid, c.relkind::text AS relkind,
           CASE WHEN c.relkind IN ('r','m','p') AND c.reltuples >= 0 THEN c.reltuples::float8 END AS est,
           has_table_privilege(c.oid, 'SELECT') AS can_select,
           has_table_privilege(c.oid, 'INSERT') AS can_insert,
           has_table_privilege(c.oid, 'UPDATE') AS can_update,
           has_table_privilege(c.oid, 'DELETE') AS can_delete,
           pg_relation_is_updatable(c.oid, false) AS upd,
           obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`, [schema, table]))[0];
  if (!rel) throw new HttpError(404, `Relation ${schema}.${table} not found`);
  const kind = REL_KIND[rel.relkind];
  if (!kind) throw new HttpError(400, `${schema}.${table} is not a table or view`);

  const columns = await queryRows<TableColumn & { typtype: string }>(connId, db, `
    SELECT a.attname AS name, a.attnum::int AS attnum,
           format_type(a.atttypid, a.atttypmod) AS "dataType",
           bt.typname AS "udtName",
           et.typname AS "elemType",
           (bt.typcategory = 'A') AS "isArray",
           bt.typcategory::text AS category,
           (SELECT json_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e
             WHERE e.enumtypid = COALESCE(et.oid, bt.oid))::text AS "enumValues",
           NOT a.attnotnull AS nullable,
           pg_get_expr(ad.adbin, ad.adrelid) AS default,
           COALESCE(a.attnum = ANY(pk.conkey), false) AS "isPrimaryKey",
           a.attidentity::text AS identity,
           a.attgenerated <> '' AS "isGenerated",
           col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
      LEFT JOIN pg_type et ON et.oid = bt.typelem AND bt.typcategory = 'A'
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`, [rel.oid]);
  for (const c of columns) {
    // the pool keeps PostgreSQL text output (arrays / json are not parsed)
    c.enumValues = parseJson(c.enumValues);
    c.updatable = !c.isGenerated && c.identity !== 'a';
    c.identity = (c.identity || '') as TableColumn['identity'];
  }

  // Row identity: primary key, else the narrowest unique index whose columns are all NOT NULL.
  let keyColumns: string[] = [];
  let keySource: TableInfo['keySource'] = null;
  const pk = await queryRows<{ cols: string | null }>(connId, db, `
    SELECT json_agg(a.attname::text ORDER BY k.ord)::text AS cols
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.conrelid = $1 AND c.contype = 'p'`, [rel.oid]);
  const pkCols = parseJson<string[]>(pk[0]?.cols);
  if (pkCols?.length) {
    keyColumns = pkCols;
    keySource = 'primary_key';
  } else if (kind === 'table' || kind === 'partitioned_table') {
    const uq = await queryRows<{ cols: string | null }>(connId, db, `
      SELECT json_agg(a.attname::text ORDER BY k.ord)::text AS cols
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = $1 AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
       GROUP BY i.indexrelid
      HAVING bool_and(a.attnotnull) AND count(*) = (SELECT i2.indnkeyatts FROM pg_index i2 WHERE i2.indexrelid = i.indexrelid)
       ORDER BY count(*), i.indexrelid
       LIMIT 1`, [rel.oid]);
    const uqCols = parseJson<string[]>(uq[0]?.cols);
    if (uqCols?.length) {
      keyColumns = uqCols;
      keySource = 'unique_index';
    }
  }

  const connectionReadOnly = !!getConnection(connId)?.readOnly;
  const upd = Number(rel.upd) || 0; // bitmask: 4 UPDATE, 8 INSERT, 16 DELETE
  const hasKey = keyColumns.length > 0;
  const canInsert = !connectionReadOnly && rel.can_insert && (upd & 8) !== 0;
  const canUpdate = !connectionReadOnly && rel.can_update && (upd & 4) !== 0 && hasKey;
  const canDelete = !connectionReadOnly && rel.can_delete && (upd & 16) !== 0 && hasKey;

  let readOnlyReason: string | null = null;
  const name = `${schema}.${table}`;
  if (connectionReadOnly) readOnlyReason = 'This connection is marked read-only.';
  else if (kind === 'materialized_view') readOnlyReason = 'Materialized views are read-only — refresh the view to update its data.';
  else if (!hasKey && (upd & 4) !== 0) {
    readOnlyReason =
      `${name} has no primary key (or NOT NULL unique index), so existing rows can't be identified safely for UPDATE / DELETE` +
      (canInsert ? ' — you can still add new rows.' : '.') +
      ' (ctid is not used: it changes on every update and after VACUUM FULL, so it could hit the wrong row.)';
  } else if ((upd & 4) === 0 && (upd & 8) === 0) {
    readOnlyReason = `This ${KIND_LABEL[kind]} is not updatable.`;
  } else if (!rel.can_update && !rel.can_insert && !rel.can_delete) {
    readOnlyReason = `You don't have INSERT / UPDATE / DELETE privileges on ${name}.`;
  } else if (!canUpdate || !canDelete || !canInsert) {
    const missing = [!canInsert && 'INSERT', !canUpdate && 'UPDATE', !canDelete && 'DELETE'].filter(Boolean).join(' / ');
    readOnlyReason = `${missing} not available on this ${KIND_LABEL[kind]} (privileges or object type).`;
  }

  return {
    schema, name: table, kind, columns: columns.map(({ typtype: _t, ...c }) => c),
    keyColumns, keySource,
    estimatedRows: rel.est == null ? null : Number(rel.est),
    canSelect: rel.can_select, canInsert, canUpdate, canDelete,
    connectionReadOnly, readOnlyReason, comment: rel.comment,
  };
}

// ---------------------------------------------------------------- SQL building

const NO_EQUALITY = new Set(['json', 'xml', 'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle']);

function colMap(info: TableInfo) {
  return new Map(info.columns.map((c) => [c.name, c]));
}

function requireCol(cols: Map<string, TableColumn>, name: string): TableColumn {
  const c = cols.get(name);
  if (!c) throw new HttpError(400, `Unknown column "${name}"`);
  return c;
}

function buildCondition(c: TableColumn, f: FilterCondition, params: unknown[]): string {
  const id = quoteIdent(c.name);
  const textId = `${id}::text`;
  const cmpId = NO_EQUALITY.has(c.udtName) ? textId : id;
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  switch (f.op) {
    case 'IS NULL': return `${id} IS NULL`;
    case 'IS NOT NULL': return `${id} IS NOT NULL`;
    case 'LIKE': case 'NOT LIKE': case 'ILIKE': case 'NOT ILIKE':
      return `${textId} ${f.op} ${p(f.value ?? '')}`;
    case 'IN': case 'NOT IN': {
      const vals = f.values ?? [];
      if (!vals.length) return f.op === 'IN' ? 'false' : 'true';
      const arr = p(vals);
      return f.op === 'IN' ? `${cmpId} = ANY(${arr})` : `NOT (${cmpId} = ANY(${arr}))`;
    }
    case 'BETWEEN': {
      const [a, b] = f.values ?? [];
      return `${cmpId} BETWEEN ${p(a ?? null)} AND ${p(b ?? null)}`;
    }
    case '=': case '<>': case '>': case '>=': case '<': case '<=':
      return `${cmpId} ${f.op} ${p(f.value ?? null)}`;
    default:
      throw new HttpError(400, `Unsupported operator ${String((f as FilterCondition).op)}`);
  }
}

function buildWhere(info: TableInfo, q: RowsQuery, params: unknown[]): string {
  const cols = colMap(info);
  const parts: string[] = [];
  for (const f of q.filters ?? []) {
    if (f.enabled === false) continue;
    parts.push(buildCondition(requireCol(cols, f.column), f, params));
  }
  const raw = q.where?.trim();
  if (raw) parts.push(`(${raw}\n)`);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function buildOrder(info: TableInfo, q: RowsQuery): string {
  const cols = colMap(info);
  const items = (q.sort ?? []).map((s) => {
    const c = requireCol(cols, s.column);
    const expr = NO_EQUALITY.has(c.udtName) ? `${quoteIdent(c.name)}::text` : quoteIdent(c.name);
    return `${expr} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`;
  });
  // Stable paging: fall back to the row key so edited rows don't jump around.
  if (!items.length && info.keyColumns.length) items.push(...info.keyColumns.map((k) => quoteIdent(k)));
  return items.length ? ` ORDER BY ${items.join(', ')}` : '';
}

function selectList(info: TableInfo, only?: string[]): string {
  const cols = colMap(info);
  const names = only?.length ? only.map((n) => requireCol(cols, n).name) : info.columns.map((c) => c.name);
  return names.map(quoteIdent).join(', ');
}

/** Run read queries in a READ ONLY transaction (raw WHERE text can't write). */
async function readOnly<T>(connId: string, db: string, fn: (c: pg.PoolClient) => Promise<T>, timeoutMs?: number): Promise<T> {
  return withClient(connId, db, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      if (timeoutMs) await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  });
}

/** Replace $n placeholders with literals (for display / "open in SQL editor" only — never executed). */
function inlineParams(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n) => {
    const v = params[Number(n) - 1];
    if (Array.isArray(v)) return `ARRAY[${v.map((x) => quoteLiteral(x)).join(', ')}]`;
    return Number(n) <= params.length ? quoteLiteral(v) : m;
  });
}

function toParam(v: CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

const isDefault = (v: WriteValue): v is { $default: true } => !!v && typeof v === 'object' && (v as any).$default === true;

interface Stmt { text: string; values: unknown[]; literal: string; kind: 'insert' | 'update' | 'delete'; keyDesc?: string }

function buildChange(info: TableInfo, ch: RowChange): Stmt {
  const cols = colMap(info);
  const target = qualified(info.schema, info.name);
  const values: unknown[] = [];
  const p = (v: unknown) => { values.push(v); return `$${values.length}`; };

  const keyClause = (key: Record<string, CellValue>) => {
    if (!info.keyColumns.length) throw new HttpError(400, `${info.schema}.${info.name} has no primary key; rows can't be identified.`);
    const text: string[] = [];
    const lit: string[] = [];
    for (const k of info.keyColumns) {
      if (!(k in key) || key[k] === null) throw new HttpError(400, `Missing key value for "${k}"`);
      text.push(`${quoteIdent(k)} = ${p(toParam(key[k]))}`);
      lit.push(`${quoteIdent(k)} = ${quoteLiteral(key[k])}`);
    }
    return { text: text.join(' AND '), literal: lit.join(' AND '), desc: info.keyColumns.map((k) => `${k}=${String(key[k])}`).join(', ') };
  };
  const writable = (name: string) => {
    const c = requireCol(cols, name);
    if (!c.updatable) throw new HttpError(400, `Column "${name}" is ${c.isGenerated ? 'generated' : 'an identity (GENERATED ALWAYS) column'} and can't be written`);
    return c;
  };

  if (ch.type === 'update') {
    const sets: string[] = [];
    const setLit: string[] = [];
    for (const [name, v] of Object.entries(ch.set)) {
      writable(name);
      if (isDefault(v)) { sets.push(`${quoteIdent(name)} = DEFAULT`); setLit.push(`${quoteIdent(name)} = DEFAULT`); }
      else { sets.push(`${quoteIdent(name)} = ${p(toParam(v))}`); setLit.push(`${quoteIdent(name)} = ${quoteLiteral(v)}`); }
    }
    if (!sets.length) throw new HttpError(400, 'Empty update');
    const k = keyClause(ch.key);
    return {
      kind: 'update', values, keyDesc: k.desc,
      text: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${k.text}`,
      literal: `UPDATE ${target} SET ${setLit.join(', ')} WHERE ${k.literal};`,
    };
  }
  if (ch.type === 'delete') {
    const k = keyClause(ch.key);
    return { kind: 'delete', values, keyDesc: k.desc, text: `DELETE FROM ${target} WHERE ${k.text}`, literal: `DELETE FROM ${target} WHERE ${k.literal};` };
  }
  const names = Object.keys(ch.values);
  if (!names.length) return { kind: 'insert', values, text: `INSERT INTO ${target} DEFAULT VALUES`, literal: `INSERT INTO ${target} DEFAULT VALUES;` };
  const vals: string[] = [];
  const lits: string[] = [];
  for (const n of names) {
    writable(n);
    const v = ch.values[n];
    if (isDefault(v)) { vals.push('DEFAULT'); lits.push('DEFAULT'); }
    else { vals.push(p(toParam(v))); lits.push(quoteLiteral(v)); }
  }
  const colList = names.map(quoteIdent).join(', ');
  return {
    kind: 'insert', values,
    text: `INSERT INTO ${target} (${colList}) VALUES (${vals.join(', ')})`,
    literal: `INSERT INTO ${target} (${colList}) VALUES (${lits.join(', ')});`,
  };
}

// ---------------------------------------------------------------- export formatting

const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid']);

function csvCell(v: CellValue, sep: string): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /["\n\r]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function jsonCell(v: CellValue, c: TableColumn): unknown {
  if (v === null || typeof v !== 'string') return v;
  if (c.udtName === 'json' || c.udtName === 'jsonb') {
    try { return JSON.parse(v); } catch { return v; }
  }
  if (NUMERIC_TYPES.has(c.udtName)) {
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v) return n;
  }
  return v;
}

function mdCell(v: CellValue): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function formatter(format: ExportFormat, cols: TableColumn[], target: string, header: boolean) {
  const names = cols.map((c) => c.name);
  switch (format) {
    case 'csv':
    case 'tsv': {
      const sep = format === 'csv' ? ',' : '\t';
      return {
        head: header ? names.map((n) => csvCell(n, sep)).join(sep) + '\n' : '',
        row: (r: CellValue[]) => r.map((v) => csvCell(v, sep)).join(sep) + '\n',
        tail: '',
      };
    }
    case 'json': {
      let first = true;
      return {
        head: '[\n',
        row: (r: CellValue[]) => {
          const o: Record<string, unknown> = {};
          cols.forEach((c, i) => { o[c.name] = jsonCell(r[i], c); });
          const s = (first ? '  ' : ',\n  ') + JSON.stringify(o);
          first = false;
          return s;
        },
        tail: '\n]\n',
      };
    }
    case 'sql': {
      const colList = names.map(quoteIdent).join(', ');
      return {
        head: '',
        row: (r: CellValue[]) => `INSERT INTO ${target} (${colList}) VALUES (${r.map((v) => quoteLiteral(v)).join(', ')});\n`,
        tail: '',
      };
    }
    case 'markdown':
      return {
        head: '| ' + names.map((n) => mdCell(n)).join(' | ') + ' |\n|' + names.map(() => ' --- |').join('') + '\n',
        row: (r: CellValue[]) => '| ' + r.map(mdCell).join(' | ') + ' |\n',
        tail: '',
      };
  }
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', sql: 'application/sql', markdown: 'text/markdown',
};
const EXT: Record<ExportFormat, string> = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql', markdown: 'md' };

// ---------------------------------------------------------------- import sessions

interface ImportSession {
  id: string;
  connId: string;
  db: string;
  client: pg.PoolClient;
  target: string;
  columns: string[];
  casts: string[];
  total: number;
  lastUsed: number;
  busy: boolean;
}
const imports = new Map<string, ImportSession>();

async function endImport(s: ImportSession, commit: boolean) {
  imports.delete(s.id);
  try {
    await s.client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    s.client.release();
  }
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const s of imports.values()) if (!s.busy && s.lastUsed < cutoff) void endImport(s, false).catch(() => {});
}, 60_000).unref();

const MAX_PARAMS = 60_000;

function insertBatchSql(s: ImportSession, nRows: number): string {
  const n = s.columns.length;
  const tuples: string[] = [];
  for (let r = 0; r < nRows; r++) {
    tuples.push('(' + s.casts.map((cast, i) => `$${r * n + i + 1}::${cast}`).join(', ') + ')');
  }
  return `INSERT INTO ${s.target} (${s.columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`;
}

function sendError(reply: FastifyReply, status: number, e: unknown, extra: Record<string, unknown> = {}) {
  return reply.status(status).send({ error: { ...toQueryError(e), ...extra } });
}

// ---------------------------------------------------------------- routes

export default async function tableDataRoutes(app: FastifyInstance) {
  app.get<{ Params: P }>(`${BASE}/info`, async (req) => {
    const { connId, db, schema, table } = req.params;
    return loadTableInfo(connId, db, schema, table);
  });

  app.post<{ Params: P; Body: RowsRequest }>(`${BASE}/rows`, async (req): Promise<RowsResponse> => {
    const { connId, db, schema, table } = req.params;
    const info = await loadTableInfo(connId, db, schema, table);
    const params: unknown[] = [];
    const limit = Math.max(1, Math.min(Number(req.body.limit) || 200, 100_000));
    const offset = Math.max(0, Number(req.body.offset) || 0);
    const where = buildWhere(info, req.body, params);
    const sql = `SELECT ${selectList(info)} FROM ${qualified(schema, table)}${where}${buildOrder(info, req.body)} LIMIT ${limit + 1} OFFSET ${offset}`;
    const t0 = performance.now();
    const res = await readOnly(connId, db, (c) => c.query({ text: sql, values: params, rowMode: 'array' }));
    const rows = res.rows as CellValue[][];
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    const pageSql = `SELECT * FROM ${qualified(schema, table)}${where}${buildOrder(info, req.body)} LIMIT ${limit} OFFSET ${offset}`;
    return { columns: info.columns.map((c) => c.name), rows, hasMore, durationMs: performance.now() - t0, sql, sqlLiteral: inlineParams(pageSql, params) };
  });

  app.post<{ Params: P; Body: RowsQuery & { exact?: boolean } }>(`${BASE}/count`, async (req): Promise<CountResponse> => {
    const { connId, db, schema, table } = req.params;
    const info = await loadTableInfo(connId, db, schema, table);
    const params: unknown[] = [];
    const where = buildWhere(info, req.body, params);
    const t0 = performance.now();
    if (req.body.exact) {
      const r = await readOnly(connId, db, (c) => c.query(`SELECT count(*)::int8 AS n FROM ${qualified(schema, table)}${where}`, params), 120_000);
      return { count: Number(r.rows[0].n), exact: true, durationMs: performance.now() - t0 };
    }
    // Planner estimate: instant even for huge tables, and respects filters.
    const r = await readOnly(connId, db, (c) => c.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${qualified(schema, table)}${where}`, params), 15_000);
    const plan = r.rows[0]['QUERY PLAN'];
    const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
    return { count: Number(parsed?.[0]?.Plan?.['Plan Rows'] ?? 0), exact: false, durationMs: performance.now() - t0 };
  });

  app.post<{ Params: P; Body: CommitRequest }>(`${BASE}/commit`, async (req, reply): Promise<CommitResponse | void> => {
    const { connId, db, schema, table } = req.params;
    const info = await loadTableInfo(connId, db, schema, table);
    const changes = req.body.changes ?? [];
    const order = { delete: 0, update: 1, insert: 2 } as const;
    const stmts = changes.map((ch) => buildChange(info, ch)).sort((a, b) => order[a.kind] - order[b.kind]);
    const sql = ['BEGIN;', ...stmts.map((s) => s.literal), 'COMMIT;'].join('\n');
    const counts = { inserted: 0, updated: 0, deleted: 0 };
    if (req.body.preview) return { sql, executed: false, ...counts, durationMs: 0 };
    if (info.connectionReadOnly) throw new HttpError(403, 'This connection is read-only.');
    if (stmts.some((s) => s.kind === 'update') && !info.canUpdate) throw new HttpError(403, info.readOnlyReason ?? 'Rows of this relation can not be updated.');
    if (stmts.some((s) => s.kind === 'delete') && !info.canDelete) throw new HttpError(403, info.readOnlyReason ?? 'Rows of this relation can not be deleted.');
    if (stmts.some((s) => s.kind === 'insert') && !info.canInsert) throw new HttpError(403, info.readOnlyReason ?? 'Rows can not be inserted into this relation.');

    const t0 = performance.now();
    let failedIndex = -1;
    try {
      await withClient(connId, db, async (client) => {
        await client.query('BEGIN');
        try {
          for (let i = 0; i < stmts.length; i++) {
            failedIndex = i;
            const s = stmts[i];
            const r = await client.query(s.text, s.values);
            if (s.kind !== 'insert' && r.rowCount !== 1) {
              throw new HttpError(409, `Row ${s.keyDesc} ${r.rowCount === 0 ? 'no longer exists (changed or deleted by someone else?)' : `matched ${r.rowCount} rows`}. Nothing was saved.`);
            }
            counts[s.kind === 'insert' ? 'inserted' : s.kind === 'update' ? 'updated' : 'deleted'] += r.rowCount ?? 0;
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        }
      });
    } catch (e: any) {
      const st = stmts[failedIndex];
      return sendError(reply, e instanceof HttpError ? e.status : 400, e, st ? { where: `while executing: ${st.literal}` } : {});
    }
    return { sql, executed: true, ...counts, durationMs: performance.now() - t0 };
  });

  /** Streaming export of all rows matching the current filter / sort. */
  app.get<{ Params: P; Querystring: ExportParams }>(`${BASE}/export`, async (req, reply) => {
    const { connId, db, schema, table } = req.params;
    const format = req.query.format;
    if (!MIME[format]) throw new HttpError(400, `Unknown format ${format}`);
    const info = await loadTableInfo(connId, db, schema, table);
    let q: RowsQuery = {};
    if (req.query.q) {
      try { q = JSON.parse(req.query.q); } catch { throw new HttpError(400, 'Invalid q parameter'); }
    }
    const only = req.query.columns ? req.query.columns.split(',').filter(Boolean) : undefined;
    const cols = only?.length ? only.map((n) => requireCol(colMap(info), n)) : info.columns;
    const params: unknown[] = [];
    const sql = `SELECT ${selectList(info, only)} FROM ${qualified(schema, table)}${buildWhere(info, q, params)}${buildOrder(info, q)}`;
    const target = qualified(schema, table);
    const fmt = formatter(format, cols, target, req.query.header !== '0');

    // Validate the query (and surface errors as JSON) before committing to a download.
    const client = await getPool(connId, db).connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    };
    try {
      await client.query('BEGIN READ ONLY');
      await client.query({ text: `${sql} LIMIT 0`, values: params });
    } catch (e) {
      await release();
      throw e;
    }
    const stream = client.query(new QueryStream(sql, params, { rowMode: 'array', batchSize: 2000 }));
    async function* body() {
      try {
        let buf = fmt.head;
        for await (const row of stream as AsyncIterable<CellValue[]>) {
          buf += fmt.row(row);
          if (buf.length > 256 * 1024) { yield buf; buf = ''; }
        }
        yield buf + fmt.tail;
      } finally {
        stream.destroy();
        await release();
      }
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `${schema}.${table}_${stamp}.${EXT[format]}`;
    reply
      .header('content-type', `${MIME[format]}; charset=utf-8`)
      .header('content-disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(body()));
  });

  // ---- CSV import: begin -> batch* -> commit | rollback (single transaction)

  app.post<{ Params: P; Body: ImportBeginRequest }>(`${BASE}/import/begin`, async (req): Promise<ImportBeginResponse> => {
    const { connId, db, schema, table } = req.params;
    const info = await loadTableInfo(connId, db, schema, table);
    if (info.connectionReadOnly) throw new HttpError(403, 'This connection is read-only.');
    if (!info.canInsert) throw new HttpError(403, `Rows can't be inserted into ${schema}.${table}.`);
    const cols = colMap(info);
    const columns = req.body.columns ?? [];
    if (!columns.length) throw new HttpError(400, 'Map at least one column');
    if (new Set(columns).size !== columns.length) throw new HttpError(400, 'A table column is mapped twice');
    for (const n of columns) {
      const c = requireCol(cols, n);
      if (!c.updatable) throw new HttpError(400, `Column "${n}" is generated / identity ALWAYS and can't be imported`);
    }
    // Cast targets come from the catalog (without typmod so length overflows raise errors instead of truncating).
    const casts = await queryRows<{ t: string }>(connId, db, `
      SELECT format_type(a.atttypid, NULL) AS t
        FROM unnest($2::text[]) WITH ORDINALITY u(name, ord)
        JOIN pg_attribute a ON a.attrelid = $1::regclass AND a.attname = u.name
       ORDER BY u.ord`, [qualified(schema, table), columns]);
    const client = await getPool(connId, db).connect();
    try {
      await client.query('BEGIN');
      if (req.body.truncate) await client.query(`TRUNCATE ${qualified(schema, table)}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw e;
    }
    const s: ImportSession = {
      id: randomUUID(), connId, db, client, target: qualified(schema, table), columns,
      casts: casts.map((c) => c.t), total: 0, lastUsed: Date.now(), busy: false,
    };
    imports.set(s.id, s);
    return { importId: s.id };
  });

  app.post<{ Params: P & { importId: string }; Body: ImportBatchRequest }>(`${BASE}/import/:importId/batch`, async (req, reply) => {
    const s = imports.get(req.params.importId);
    if (!s) throw new HttpError(404, 'Import session expired or unknown (it is rolled back after 10 minutes of inactivity).');
    if (s.busy) throw new HttpError(409, 'Previous batch still running');
    s.busy = true;
    s.lastUsed = Date.now();
    const rows = req.body.rows ?? [];
    const n = s.columns.length;
    const first = req.body.firstRowNumber ?? s.total + 1;
    const per = Math.max(1, Math.floor(MAX_PARAMS / n));
    try {
      await s.client.query('SAVEPOINT batch');
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const values: unknown[] = [];
        for (const r of chunk) for (let k = 0; k < n; k++) values.push(r[k] ?? null);
        await s.client.query(insertBatchSql(s, chunk.length), values);
      }
      await s.client.query('RELEASE SAVEPOINT batch');
      s.total += rows.length;
      s.busy = false;
      return { inserted: rows.length, total: s.total } satisfies ImportBatchResponse;
    } catch (e) {
      // Pinpoint the failing row, then abort the whole import.
      let rowNumber: number | undefined;
      let row: (string | null)[] | undefined;
      let err: unknown = e;
      try {
        await s.client.query('ROLLBACK TO SAVEPOINT batch');
        for (let i = 0; i < rows.length; i++) {
          try {
            await s.client.query('SAVEPOINT one');
            await s.client.query(insertBatchSql(s, 1), s.columns.map((_, k) => rows[i][k] ?? null));
            await s.client.query('RELEASE SAVEPOINT one');
          } catch (e2) {
            rowNumber = first + i;
            row = rows[i];
            err = e2;
            break;
          }
        }
      } catch { /* connection broken: report the original error */ }
      await endImport(s, false).catch(() => {});
      return sendError(reply, 400, err, { rowNumber, row, rolledBack: true });
    }
  });

  app.post<{ Params: P & { importId: string } }>(`${BASE}/import/:importId/commit`, async (req) => {
    const s = imports.get(req.params.importId);
    if (!s) throw new HttpError(404, 'Import session expired or unknown.');
    await endImport(s, true);
    return { ok: true, total: s.total };
  });

  app.post<{ Params: P & { importId: string } }>(`${BASE}/import/:importId/rollback`, async (req) => {
    const s = imports.get(req.params.importId);
    if (s) await endImport(s, false);
    return { ok: true };
  });
}
