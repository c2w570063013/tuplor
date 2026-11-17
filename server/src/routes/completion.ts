import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type {
  Catalog, CatalogColumn, CatalogForeignKey, CatalogFunction, CatalogRelation, HistoryEntry, HistoryInput, Snippet,
} from '../../../shared/completion';
import { closeSession, queryRows } from '../db';
import { HttpError } from '../lib/errors';
import { readJson, writeJson } from '../lib/paths';

/**
 * Feature module: SQL editor support (owned by the SQL Editor & Explain team).
 *  - compact schema catalog for autocomplete / hover
 *  - query history (~/.tuplor/history.json)
 *  - saved snippets (~/.tuplor/snippets.json)
 * See shared/completion.ts for the contract.
 */

/** Popular built-in functions offered in autocomplete (signatures are read from pg_proc). */
const BUILTIN_FUNCS = (
  'abs avg array_agg array_append array_cat array_length array_position array_remove array_to_string bool_and bool_or ' +
  'btrim ceil ceiling char_length coalesce concat concat_ws count cume_dist current_database current_schema current_setting ' +
  'date_bin date_part date_trunc dense_rank encode decode every exp extract first_value floor format format_type gen_random_uuid ' +
  'generate_series generate_subscripts greatest initcap jsonb_agg jsonb_array_elements jsonb_array_elements_text jsonb_array_length ' +
  'jsonb_build_array jsonb_build_object jsonb_each jsonb_each_text jsonb_extract_path jsonb_extract_path_text jsonb_insert ' +
  'jsonb_object_agg jsonb_object_keys jsonb_path_query jsonb_pretty jsonb_set jsonb_strip_nulls jsonb_typeof json_agg ' +
  'json_build_object json_object_agg lag last_value lead least left length lower lpad ltrim make_date make_interval make_timestamp ' +
  'max md5 min mod now nth_value ntile nullif percent_rank percentile_cont percentile_disc pg_backend_pid pg_cancel_backend ' +
  'pg_column_size pg_database_size pg_get_viewdef pg_get_functiondef pg_indexes_size pg_relation_size pg_size_pretty pg_sleep ' +
  'pg_table_size pg_terminate_backend pg_total_relation_size pg_typeof position power random rank regexp_match regexp_matches ' +
  'regexp_replace regexp_split_to_array regexp_split_to_table repeat replace reverse right round row_number rpad rtrim ' +
  'set_config sign split_part sqrt starts_with statement_timestamp string_agg string_to_array strpos substr substring sum ' +
  'clock_timestamp timeofday to_char to_date to_json to_jsonb to_number to_timestamp translate trim trunc unnest upper ' +
  'age justify_interval isfinite array_dims cardinality row_to_json json_populate_record jsonb_populate_record ' +
  'stddev variance corr covar_pop regr_slope bit_and bit_or xmlagg nextval currval setval lastval quote_ident quote_literal ' +
  'quote_nullable to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank ts_headline uuid_generate_v4 ' +
  'any_value range_agg width_bucket'
).split(/\s+/);

const COMMON_TYPES = [
  'bigint', 'bigserial', 'bit', 'boolean', 'box', 'bytea', 'char', 'character varying', 'cidr', 'circle', 'date',
  'double precision', 'inet', 'integer', 'interval', 'json', 'jsonb', 'line', 'lseg', 'macaddr', 'money', 'numeric',
  'path', 'point', 'polygon', 'real', 'smallint', 'smallserial', 'serial', 'text', 'time', 'time with time zone',
  'timestamp', 'timestamp with time zone', 'timestamptz', 'tsquery', 'tsvector', 'uuid', 'varchar', 'xml', 'int', 'int2',
  'int4', 'int8', 'float4', 'float8', 'decimal', 'bool', 'regclass', 'oid', 'name', 'citext', 'hstore', 'int4range',
  'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange', 'record', 'void', 'trigger',
];

async function loadCatalog(connId: string, db: string): Promise<Catalog> {
  const sysFilter = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'`;
  const [sp, schemas, rels, cols, funcs, builtins, types, fks] = await Promise.all([
    queryRows<{ s: string }>(connId, db, `SELECT array_to_string(current_schemas(false), chr(31)) AS s`),
    queryRows<{ nspname: string }>(connId, db, `SELECT n.nspname FROM pg_namespace n WHERE ${sysFilter} ORDER BY 1`),
    queryRows<{ oid: number; s: string; n: string; k: string; c: string | null; est: number }>(connId, db, `
      SELECT c.oid::int AS oid, n.nspname AS s, c.relname AS n, c.relkind::text AS k,
             obj_description(c.oid, 'pg_class') AS c, c.reltuples::float8 AS est
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${sysFilter}
       ORDER BY 2, 3
       LIMIT 20000`),
    queryRows<{ oid: number; n: string; t: string; nn: boolean; pk: boolean; c: string | null }>(connId, db, `
      SELECT a.attrelid::int AS oid, a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t, a.attnotnull AS nn,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
             col_description(a.attrelid, a.attnum) AS c
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${sysFilter}
       ORDER BY a.attrelid, a.attnum
       LIMIT 200000`),
    queryRows<CatalogFunction & { c: string | null }>(connId, db, `
      SELECT n.nspname AS s, p.proname AS n, pg_get_function_arguments(p.oid) AS args,
             COALESCE(pg_get_function_result(p.oid), '') AS ret, p.prokind::text AS k, obj_description(p.oid, 'pg_proc') AS c
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${sysFilter}
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1, 2
       LIMIT 5000`),
    queryRows<CatalogFunction>(connId, db, `
      SELECT DISTINCT ON (p.proname, pg_get_function_arguments(p.oid)) 'pg_catalog' AS s, p.proname AS n,
             pg_get_function_arguments(p.oid) AS args, COALESCE(pg_get_function_result(p.oid), '') AS ret, p.prokind::text AS k
        FROM pg_proc p
       WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($1::text[])
       ORDER BY p.proname, pg_get_function_arguments(p.oid)`, [BUILTIN_FUNCS]),
    queryRows<{ name: string }>(connId, db, `
      SELECT CASE WHEN n.nspname IN ('pg_catalog','public') THEN t.typname ELSE n.nspname || '.' || t.typname END AS name
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname <> 'information_schema' AND (t.typtype IN ('e','d','r','m') OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
         OR (t.typtype = 'b' AND n.nspname NOT IN ('pg_catalog','information_schema') AND t.typname NOT LIKE '\\_%'))
       ORDER BY 1 LIMIT 2000`),
    queryRows<{ oid: number; cols: string; rs: string; rn: string; rcols: string }>(connId, db, `
      SELECT c.conrelid::int AS oid,
             array_to_string(ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o), chr(31)) AS cols,
             rn.nspname AS rs, r.relname AS rn,
             array_to_string(ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o), chr(31)) AS rcols
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'f' AND ${sysFilter}
       LIMIT 20000`),
  ]);
  const fkByOid = new Map<number, CatalogForeignKey[]>();
  for (const f of fks) {
    let arr = fkByOid.get(f.oid);
    if (!arr) fkByOid.set(f.oid, (arr = []));
    arr.push({ cols: f.cols.split('\x1f'), rs: f.rs, rn: f.rn, rcols: f.rcols.split('\x1f') });
  }

  const byOid = new Map<number, CatalogColumn[]>();
  for (const c of cols) {
    let arr = byOid.get(c.oid);
    if (!arr) byOid.set(c.oid, (arr = []));
    const col: CatalogColumn = { n: c.n, t: c.t };
    if (c.nn) col.nn = true;
    if (c.pk) col.pk = true;
    if (c.c) col.c = c.c;
    arr.push(col);
  }
  const relations: CatalogRelation[] = rels.map((r) => {
    const rel: CatalogRelation = { s: r.s, n: r.n, k: r.k as CatalogRelation['k'], cols: byOid.get(r.oid) ?? [] };
    if (r.c) rel.c = r.c;
    if (r.est >= 0) rel.est = Math.round(r.est);
    const fk = fkByOid.get(r.oid);
    if (fk) rel.fks = fk;
    return rel;
  });

  const functions = funcs.map((f) => {
    const out: CatalogFunction = { s: f.s, n: f.n, args: f.args, ret: f.ret, k: f.k };
    if (f.c) out.c = f.c;
    return out;
  });

  return {
    searchPath: sp[0]?.s ? sp[0].s.split('\x1f') : ['public'],
    schemas: schemas.map((s) => s.nspname),
    relations,
    functions,
    builtins,
    types: [...new Set([...COMMON_TYPES, ...types.map((t) => t.name)])],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- history

const HISTORY_FILE = 'history.json';
const HISTORY_CAP = 5000;
const MAX_SQL_LEN = 100_000;

let history: HistoryEntry[] | null = null;
let historyTimer: NodeJS.Timeout | null = null;

function loadHistory(): HistoryEntry[] {
  if (!history) {
    const data = readJson<HistoryEntry[]>(HISTORY_FILE, []);
    history = Array.isArray(data) ? data : [];
  }
  return history;
}

/** Writes are coalesced: a busy editor can record many queries per second. */
function scheduleHistoryWrite() {
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    try { writeJson(HISTORY_FILE, history ?? []); } catch { /* disk issues are non-fatal */ }
  }, 400);
}

function flushHistory() {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
    try { writeJson(HISTORY_FILE, history ?? []); } catch { /* ignore */ }
  }
}
process.on('exit', flushHistory);

// ---------------------------------------------------------------- snippets

const SNIPPETS_FILE = 'snippets.json';
const loadSnippets = () => {
  const s = readJson<Snippet[]>(SNIPPETS_FILE, []);
  return Array.isArray(s) ? s : [];
};

export default async function completionRoutes(app: FastifyInstance) {
  app.get<{ Params: { connId: string; db: string } }>('/api/c/:connId/db/:db/completion/catalog', async (req) =>
    loadCatalog(req.params.connId, req.params.db),
  );

  app.get<{ Querystring: { q?: string; connId?: string; db?: string; limit?: string; errors?: string } }>('/api/history', async (req) => {
    const { q, connId, db, errors } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), HISTORY_CAP);
    const terms = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const out: HistoryEntry[] = [];
    const all = loadHistory();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const h = all[i];
      if (connId && h.connId !== connId) continue;
      if (db && h.database !== db) continue;
      if (errors === 'only' && !h.error) continue;
      if (errors === 'hide' && h.error) continue;
      if (terms.length) {
        const hay = (h.sql + ' ' + h.database + ' ' + (h.connName ?? '')).toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      out.push(h);
    }
    return out;
  });

  app.post<{ Body: HistoryInput }>('/api/history', async (req) => {
    const b = req.body;
    if (!b || typeof b.sql !== 'string' || !b.sql.trim()) throw new HttpError(400, 'sql is required');
    const all = loadHistory();
    const entry: HistoryEntry = {
      id: randomUUID(),
      sql: b.sql.length > MAX_SQL_LEN ? b.sql.slice(0, MAX_SQL_LEN) : b.sql,
      connId: String(b.connId ?? ''),
      connName: b.connName,
      database: String(b.database ?? ''),
      at: new Date().toISOString(),
      durationMs: Number(b.durationMs) || 0,
      rows: b.rows == null ? null : Number(b.rows),
      error: b.error ? String(b.error).slice(0, 2000) : undefined,
      statements: b.statements,
    };
    // collapse immediate repeats of the same query into one (most recent) entry
    const last = all[all.length - 1];
    if (last && last.sql === entry.sql && last.connId === entry.connId && last.database === entry.database) all.pop();
    all.push(entry);
    if (all.length > HISTORY_CAP) all.splice(0, all.length - HISTORY_CAP);
    scheduleHistoryWrite();
    return entry;
  });

  app.delete<{ Params: { id: string } }>('/api/history/:id', async (req) => {
    const all = loadHistory();
    const i = all.findIndex((h) => h.id === req.params.id);
    if (i >= 0) { all.splice(i, 1); scheduleHistoryWrite(); }
    return { ok: i >= 0 };
  });

  app.delete('/api/history', async () => {
    history = [];
    scheduleHistoryWrite();
    return { ok: true };
  });

  // navigator.sendBeacon() can only POST: lets the editor release its session on page unload
  app.post<{ Params: { connId: string; sessionId: string } }>('/api/c/:connId/sessions/:sessionId/close', async (req) => {
    await closeSession(req.params.sessionId);
    return { ok: true };
  });

  app.get('/api/snippets', async () => loadSnippets());

  app.post<{ Body: Partial<Snippet> }>('/api/snippets', async (req) => {
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Snippet name is required');
    if (typeof b.sql !== 'string') throw new HttpError(400, 'sql is required');
    const all = loadSnippets();
    const now = new Date().toISOString();
    const i = b.id ? all.findIndex((s) => s.id === b.id) : -1;
    const snip: Snippet = {
      id: i >= 0 ? all[i].id : randomUUID(),
      name,
      sql: b.sql,
      description: b.description || undefined,
      createdAt: i >= 0 ? all[i].createdAt : now,
      updatedAt: now,
    };
    if (i >= 0) all[i] = snip;
    else all.push(snip);
    writeJson(SNIPPETS_FILE, all);
    return snip;
  });

  app.delete<{ Params: { id: string } }>('/api/snippets/:id', async (req) => {
    const all = loadSnippets();
    const next = all.filter((s) => s.id !== req.params.id);
    writeJson(SNIPPETS_FILE, next);
    return { ok: next.length !== all.length };
  });
}
