import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type {
  ApplyRequest, ColumnDetail, CompositeDetails, ConstraintDetail, DependencyRef, DomainDetails, EnumDetails, ExtensionInfo,
  ForeignKeyDetail, FunctionDetails, GrantDetail, IndexDetail, ObjectDetails, PartitionDetail, PolicyDetail, SequenceDetails,
  TableDetails, TableStats, TriggerDetail, TypeSuggestion, TypeUsage, ViewDetails,
} from '../../../shared/schema';
import type { DbObjectKind } from '../../../shared/types';
import { getPool, withClient, withTransaction } from '../db';
import { HttpError, toQueryError } from '../lib/errors';

/**
 * Explorer & Structure endpoints (catalog introspection, DDL generation, DDL execution).
 * Prefix: /api/c/:connId/db/:db/schema
 */

// ------------------------------------------------------------------ helpers

/** Run a query and return its rows decoded via JSON (proper numbers / arrays / nested objects). */
async function jrows<T>(connId: string, db: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await getPool(connId, db).query(`SELECT coalesce(json_agg(q), '[]'::json)::text AS j FROM (${sql}) q`, params);
  return JSON.parse(r.rows[0].j);
}
async function jrow<T>(connId: string, db: string, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await jrows<T>(connId, db, sql, params))[0];
}

const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column ' +
  'concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp ' +
  'current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike ' +
  'in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null ' +
  'offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric ' +
  'system_user table tablesample then to trailing true union unique user using variadic verbose when where window with').split(' '));

/** Quote an identifier only when needed (nicer DDL than always-quoted). */
function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}
const qn = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;
function lit(s: string): string {
  return s.includes('\\') ? "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'" : "'" + s.replace(/'/g, "''") + "'";
}

const RELKIND: Record<string, DbObjectKind> = {
  r: 'table', p: 'partitioned_table', v: 'view', m: 'materialized_view', f: 'foreign_table', S: 'sequence', i: 'index', I: 'index', c: 'type',
};
const relkindSql = `CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
  WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' WHEN 'c' THEN 'type' ELSE 'index' END`;

const FK_ACTION: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

async function relOid(connId: string, db: string, schema: string, name: string): Promise<{ oid: number; relkind: string }> {
  const r = await jrow<{ oid: number; relkind: string }>(connId, db, `
    SELECT c.oid::int AS oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
  if (!r) throw new HttpError(404, `Relation ${schema}.${name} does not exist`);
  return r;
}

// ------------------------------------------------------------------ table introspection

const GRANTS_SQL = (aclExpr: string, defaultKind: string, ownerExpr: string, from: string) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         pg_get_userbyid(a.grantor) AS grantor, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM ${from}, aclexplode(COALESCE(${aclExpr}, acldefault('${defaultKind}', ${ownerExpr}))) a`;

async function loadColumns(connId: string, db: string, oid: number, schema: string, name: string) {
  return jrows<Omit<ColumnDetail, 'isPrimaryKey' | 'isUnique' | 'fk'>>(connId, db, `
    SELECT a.attnum::int AS attnum, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS "dataType",
           a.atttypid::int AS "typeOid", t.typname AS "typeName", tn.nspname AS "typeSchema", t.typtype AS "typeKind",
           NOT a.attnotnull AS nullable,
           CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) END AS default,
           CASE WHEN a.attgenerated <> '' THEN pg_get_expr(ad.adbin, ad.adrelid) END AS "generatedExpr",
           a.attidentity::text AS identity, a.attgenerated::text AS generated,
           CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
             (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation)
           END AS collation,
           col_description(a.attrelid, a.attnum) AS comment,
           NOT a.attislocal AS inherited,
           st.null_frac AS "nullFrac", st.n_distinct AS "nDistinct", st.avg_width AS "avgWidth"
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_namespace tn ON tn.oid = t.typnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN LATERAL (
        SELECT s.null_frac, s.n_distinct, s.avg_width FROM pg_stats s
         WHERE s.schemaname = $2 AND s.tablename = $3 AND s.attname = a.attname
         ORDER BY s.inherited DESC LIMIT 1) st ON true
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`, [oid, schema, name]);
}

async function loadIndexes(connId: string, db: string, oid: number) {
  return jrows<IndexDetail>(connId, db, `
    SELECT i.indexrelid::int AS oid, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, am.amname AS method,
           i.indisunique AS "isUnique", i.indisprimary AS "isPrimary", i.indisvalid AS "isValid",
           (SELECT conname FROM pg_constraint WHERE conindid = i.indexrelid AND conrelid = i.indrelid AND contype IN ('p','u','x') LIMIT 1) AS constraint,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS columns,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(i.indnkeyatts + 1, i.indnatts) k ORDER BY k) AS include,
           pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
           pg_relation_size(i.indexrelid) AS "sizeBytes",
           s.idx_scan AS scans,
           obj_description(i.indexrelid, 'pg_class') AS comment,
           EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid) AS "isInherited"
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
      LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
     WHERE i.indrelid = $1
     ORDER BY i.indisprimary DESC, ic.relname`, [oid]);
}

const colArray = (keys: string, rel: string) =>
  `ARRAY(SELECT a.attname FROM unnest(${keys}) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.n ORDER BY k.o)`;

async function loadConstraints(connId: string, db: string, oid: number) {
  return jrows<ConstraintDetail>(connId, db, `
    SELECT c.oid::int AS oid, c.conname AS name, c.contype::text AS type, pg_get_constraintdef(c.oid, true) AS definition,
           ${colArray('c.conkey', 'c.conrelid')} AS columns,
           c.condeferrable AS deferrable, c.condeferred AS deferred, c.convalidated AS validated, c.conislocal AS "isLocal",
           obj_description(c.oid, 'pg_constraint') AS comment,
           fn.nspname AS "refSchema", fc.relname AS "refTable",
           CASE WHEN c.contype = 'f' THEN ${colArray('c.confkey', 'c.confrelid')} ELSE ARRAY[]::name[] END AS "refColumns",
           CASE WHEN c.contype = 'f' THEN c.confupdtype::text END AS "onUpdate",
           CASE WHEN c.contype = 'f' THEN c.confdeltype::text END AS "onDelete"
      FROM pg_constraint c
      LEFT JOIN pg_class fc ON fc.oid = c.confrelid
      LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
     WHERE c.conrelid = $1 AND c.contype IN ('p','u','f','c','x','t')
     ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 WHEN 'c' THEN 3 ELSE 4 END, c.conname`, [oid]);
}

async function loadReferencedBy(connId: string, db: string, oid: number) {
  const rows = await jrows<ForeignKeyDetail>(connId, db, `
    SELECT c.oid::int AS oid, c.conname AS name, pg_get_constraintdef(c.oid, true) AS definition,
           n.nspname AS "fromSchema", cl.relname AS "fromTable", ${colArray('c.conkey', 'c.conrelid')} AS "fromColumns",
           tn.nspname AS "toSchema", tc.relname AS "toTable", ${colArray('c.confkey', 'c.confrelid')} AS "toColumns",
           c.confupdtype::text AS "onUpdate", c.confdeltype::text AS "onDelete", c.convalidated AS validated
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_class tc ON tc.oid = c.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
     WHERE c.confrelid = $1 AND c.contype = 'f' AND c.conparentid = 0
     ORDER BY n.nspname, cl.relname, c.conname`, [oid]);
  for (const r of rows) { r.onUpdate = FK_ACTION[r.onUpdate] ?? r.onUpdate; r.onDelete = FK_ACTION[r.onDelete] ?? r.onDelete; }
  return rows;
}

function decodeTrigger(r: any): TriggerDetail {
  const t = r.tgtype as number;
  const events: string[] = [];
  if (t & 4) events.push('INSERT');
  if (t & 8) events.push('DELETE');
  if (t & 16) events.push('UPDATE');
  if (t & 32) events.push('TRUNCATE');
  const { tgtype: _drop, ...rest } = r;
  return { ...rest, timing: t & 64 ? 'INSTEAD OF' : t & 2 ? 'BEFORE' : 'AFTER', level: t & 1 ? 'ROW' : 'STATEMENT', events };
}

async function loadTriggers(connId: string, db: string, oid: number) {
  const rows = await jrows<any>(connId, db, `
    SELECT t.oid::int AS oid, t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled::text AS enabled,
           t.tgtype::int AS tgtype, p.proname AS "functionName", pn.nspname AS "functionSchema", p.oid::int AS "functionOid",
           t.tgparentid <> 0 AS "isInherited", t.tgconstraint <> 0 AS "isConstraint", obj_description(t.oid, 'pg_trigger') AS comment
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE t.tgrelid = $1 AND NOT t.tgisinternal
     ORDER BY t.tgname`, [oid]);
  return rows.map(decodeTrigger);
}

async function loadPartitions(connId: string, db: string, oid: number) {
  return jrows<PartitionDetail>(connId, db, `
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound,
           ${relkindSql} AS kind, GREATEST(c.reltuples, 0)::float8 AS "estRows",
           CASE WHEN c.relkind = 'p' THEN (SELECT COALESCE(sum(pg_total_relation_size(pt.relid)), 0) FROM pg_partition_tree(c.oid) pt)
                ELSE pg_total_relation_size(c.oid) END AS "sizeBytes"
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent = $1 AND c.relispartition
     ORDER BY pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT', c.relname`, [oid]);
}

async function loadStats(connId: string, db: string, oid: number): Promise<TableStats> {
  const r = await jrow<TableStats>(connId, db, `
    WITH parts AS (
      SELECT relid FROM pg_partition_tree($1::regclass) WHERE isleaf
      UNION SELECT $1::oid WHERE (SELECT relkind FROM pg_class WHERE oid = $1) <> 'p'
    ), s AS (
      SELECT sum(n_live_tup) AS live, sum(n_dead_tup) AS dead, sum(seq_scan) AS seq, sum(seq_tup_read) AS seqread,
             sum(idx_scan) AS idx, sum(idx_tup_fetch) AS idxfetch, sum(n_tup_ins) AS ins, sum(n_tup_upd) AS upd, sum(n_tup_del) AS del,
             sum(n_tup_hot_upd) AS hot, sum(n_mod_since_analyze) AS mods,
             max(last_vacuum) AS lv, max(last_autovacuum) AS lav, max(last_analyze) AS la, max(last_autoanalyze) AS laa,
             sum(vacuum_count) AS vc, sum(autovacuum_count) AS avc, sum(analyze_count) AS ac, sum(autoanalyze_count) AS aac
        FROM pg_stat_all_tables WHERE relid IN (SELECT relid FROM parts)
    )
    SELECT (SELECT COALESCE(sum(pg_total_relation_size(relid)), 0) FROM parts)::float8 AS "totalBytes",
           (SELECT COALESCE(sum(pg_relation_size(relid)), 0) FROM parts)::float8 AS "tableBytes",
           (SELECT COALESCE(sum(pg_indexes_size(relid)), 0) FROM parts)::float8 AS "indexBytes",
           (SELECT COALESCE(sum(pg_total_relation_size(NULLIF(c2.reltoastrelid, 0))), 0) FROM parts JOIN pg_class c2 ON c2.oid = parts.relid)::float8 AS "toastBytes",
           (SELECT COALESCE(sum(GREATEST(c2.reltuples, 0)), 0) FROM parts JOIN pg_class c2 ON c2.oid = parts.relid)::float8 AS "estRows",
           (SELECT COALESCE(sum(c2.relpages), 0) FROM parts JOIN pg_class c2 ON c2.oid = parts.relid)::float8 AS pages,
           s.live::float8 AS "liveTuples", s.dead::float8 AS "deadTuples", s.seq::float8 AS "seqScan", s.seqread::float8 AS "seqTupRead",
           s.idx::float8 AS "idxScan", s.idxfetch::float8 AS "idxTupFetch", s.ins::float8 AS inserts, s.upd::float8 AS updates,
           s.del::float8 AS deletes, s.hot::float8 AS "hotUpdates", s.mods::float8 AS "modsSinceAnalyze",
           s.lv AS "lastVacuum", s.lav AS "lastAutovacuum", s.la AS "lastAnalyze", s.laa AS "lastAutoanalyze",
           s.vc::float8 AS "vacuumCount", s.avc::float8 AS "autovacuumCount", s.ac::float8 AS "analyzeCount", s.aac::float8 AS "autoanalyzeCount"
      FROM s`, [oid]);
  return r!;
}

async function loadTable(connId: string, db: string, schema: string, name: string): Promise<TableDetails> {
  const { oid } = await relOid(connId, db, schema, name);
  const base = await jrow<any>(connId, db, `
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, ${relkindSql} AS kind,
           pg_get_userbyid(c.relowner) AS owner, obj_description(c.oid, 'pg_class') AS comment,
           ts.spcname AS tablespace, c.relpersistence::text AS persistence, am.amname AS "accessMethod",
           c.relrowsecurity AS "rlsEnabled", c.relforcerowsecurity AS "rlsForced", COALESCE(c.reloptions, ARRAY[]::text[]) AS options,
           CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS "partitionKey",
           (SELECT json_build_object('schema', pn.nspname, 'name', pc.relname, 'bound', pg_get_expr(c.relpartbound, c.oid))
              FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             WHERE i.inhrelid = c.oid AND c.relispartition) AS "partitionOf",
           ARRAY(SELECT json_build_object('schema', pn.nspname, 'name', pc.relname)
              FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             WHERE i.inhrelid = c.oid AND NOT c.relispartition ORDER BY i.inhseqno) AS inherits
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
      LEFT JOIN pg_am am ON am.oid = c.relam
     WHERE c.oid = $1`, [oid]);

  const [cols, indexes, constraints, referencedBy, triggers, partitions, stats, grants, colGrants, policies] = await Promise.all([
    loadColumns(connId, db, oid, schema, name),
    loadIndexes(connId, db, oid),
    loadConstraints(connId, db, oid),
    loadReferencedBy(connId, db, oid),
    loadTriggers(connId, db, oid),
    loadPartitions(connId, db, oid),
    loadStats(connId, db, oid),
    jrows<GrantDetail>(connId, db, GRANTS_SQL('c.relacl', 'r', 'c.relowner', 'pg_class c') + ' WHERE c.oid = $1 ORDER BY 1, 3', [oid]),
    jrows<GrantDetail>(connId, db, `
      SELECT CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END AS grantee, pg_get_userbyid(g.grantor) AS grantor,
             g.privilege_type AS privilege, g.is_grantable AS grantable, a.attname AS column
        FROM pg_attribute a, aclexplode(a.attacl) g
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL ORDER BY 1, 5, 3`, [oid]),
    jrows<PolicyDetail>(connId, db, `
      SELECT policyname AS name, permissive, roles::text[] AS roles, cmd, qual AS using, with_check AS check
        FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY policyname`, [schema, name]),
  ]);

  const pk = constraints.find((c) => c.type === 'p');
  const uniques = constraints.filter((c) => c.type === 'u' && c.columns.length === 1).map((c) => c.columns[0]);
  const fks = constraints.filter((c) => c.type === 'f');
  const columns: ColumnDetail[] = cols.map((c) => {
    const fk = fks.find((f) => f.columns.includes(c.name));
    return {
      ...c,
      isPrimaryKey: !!pk?.columns.includes(c.name),
      isUnique: uniques.includes(c.name),
      fk: fk ? { constraint: fk.name, schema: fk.refSchema!, table: fk.refTable!, column: fk.refColumns[fk.columns.indexOf(c.name)] } : null,
    };
  });
  const foreignKeys: ForeignKeyDetail[] = fks.map((f) => ({
    oid: f.oid, name: f.name, definition: f.definition, fromSchema: schema, fromTable: name, fromColumns: f.columns,
    toSchema: f.refSchema!, toTable: f.refTable!, toColumns: f.refColumns,
    onUpdate: FK_ACTION[f.onUpdate!] ?? '', onDelete: FK_ACTION[f.onDelete!] ?? '', validated: f.validated,
  }));
  return { ...base, columns, indexes, constraints, foreignKeys, referencedBy, triggers, partitions, stats, grants: [...grants, ...colGrants], policies };
}

// ------------------------------------------------------------------ DDL generation

function grantStatements(target: string, objType: string, owner: string, grants: GrantDetail[]): string[] {
  const out: string[] = [];
  const by = new Map<string, { privs: string[]; grantable: boolean; column?: string | null }>();
  for (const g of grants) {
    if (g.grantee === owner && !g.column) continue;
    const key = `${g.grantee}\u0000${g.grantable}\u0000${g.column ?? ''}`;
    if (!by.has(key)) by.set(key, { privs: [], grantable: g.grantable, column: g.column });
    by.get(key)!.privs.push(g.privilege);
  }
  for (const [key, v] of by) {
    const grantee = key.split('\u0000')[0];
    const who = grantee === 'PUBLIC' ? 'PUBLIC' : ident(grantee);
    const privs = v.column ? v.privs.map((p) => `${p} (${ident(v.column!)})`).join(', ') : v.privs.join(', ');
    out.push(`GRANT ${privs} ON ${objType}${target} TO ${who}${v.grantable ? ' WITH GRANT OPTION' : ''};`);
  }
  return out;
}

function columnDef(c: ColumnDetail): string {
  let s = `${ident(c.name)} ${c.dataType}`;
  if (c.collation) s += ` COLLATE ${c.collation}`;
  if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
  if (c.generated) s += ` GENERATED ALWAYS AS (${c.generatedExpr})${c.generated === 's' ? ' STORED' : ' VIRTUAL'}`;
  if (c.default != null && !c.identity) s += ` DEFAULT ${c.default}`;
  if (!c.nullable) s += ' NOT NULL';
  return s;
}

function tableDdl(t: TableDetails): string {
  const name = qn(t.schema, t.name);
  const out: string[] = [];
  const kw = t.kind === 'foreign_table' ? 'FOREIGN TABLE' : t.persistence === 'u' ? 'UNLOGGED TABLE' : 'TABLE';
  let body: string;
  if (t.partitionOf) {
    const own = t.constraints.filter((c) => c.isLocal && c.type !== 't');
    body = `CREATE ${kw} ${name} PARTITION OF ${qn(t.partitionOf.schema, t.partitionOf.name)}`;
    if (own.length) body += ` (\n${own.map((c) => `    CONSTRAINT ${ident(c.name)} ${c.definition}`).join(',\n')}\n)`;
    body += `\n    ${t.partitionOf.bound}`;
  } else {
    const lines = t.columns.filter((c) => !c.inherited).map((c) => '    ' + columnDef(c));
    for (const c of t.constraints) {
      if (!c.isLocal || c.type === 't') continue;
      lines.push(`    CONSTRAINT ${ident(c.name)} ${c.definition}`);
    }
    body = `CREATE ${kw} ${name} (\n${lines.join(',\n')}\n)`;
    if (t.inherits.length) body += `\nINHERITS (${t.inherits.map((i) => qn(i.schema, i.name)).join(', ')})`;
  }
  if (t.partitionKey) body += `\nPARTITION BY ${t.partitionKey}`;
  if (t.accessMethod && t.accessMethod !== 'heap' && t.kind === 'table') body += `\nUSING ${t.accessMethod}`;
  if (t.options.length) body += `\nWITH (${t.options.join(', ')})`;
  if (t.tablespace) body += `\nTABLESPACE ${ident(t.tablespace)}`;
  out.push(body + ';');

  const indexes = t.indexes.filter((i) => !i.constraint && !i.isInherited);
  if (indexes.length) out.push('', ...indexes.map((i) => i.definition + ';'));

  const triggers = t.triggers.filter((tr) => !tr.isInherited && !tr.isConstraint);
  if (triggers.length) {
    out.push('', ...triggers.map((tr) => tr.definition + ';'));
    for (const tr of triggers) {
      if (tr.enabled === 'D') out.push(`ALTER TABLE ${name} DISABLE TRIGGER ${ident(tr.name)};`);
    }
  }

  if (t.rlsEnabled || t.policies.length) {
    out.push('');
    if (t.rlsEnabled) out.push(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`);
    if (t.rlsForced) out.push(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;`);
    for (const p of t.policies) {
      let s = `CREATE POLICY ${ident(p.name)} ON ${name}`;
      if (p.permissive !== 'PERMISSIVE') s += ` AS ${p.permissive}`;
      if (p.cmd !== 'ALL') s += ` FOR ${p.cmd}`;
      if (p.roles.length && !(p.roles.length === 1 && p.roles[0] === 'public')) s += ` TO ${p.roles.map(ident).join(', ')}`;
      if (p.using) s += ` USING (${p.using})`;
      if (p.check) s += ` WITH CHECK (${p.check})`;
      out.push(s + ';');
    }
  }

  const comments: string[] = [];
  if (t.comment) comments.push(`COMMENT ON TABLE ${name} IS ${lit(t.comment)};`);
  for (const c of t.columns) if (c.comment && !c.inherited) comments.push(`COMMENT ON COLUMN ${name}.${ident(c.name)} IS ${lit(c.comment)};`);
  for (const c of t.constraints) if (c.comment && c.isLocal) comments.push(`COMMENT ON CONSTRAINT ${ident(c.name)} ON ${name} IS ${lit(c.comment)};`);
  for (const i of indexes) if (i.comment) comments.push(`COMMENT ON INDEX ${qn(t.schema, i.name)} IS ${lit(i.comment)};`);
  for (const tr of triggers) if (tr.comment) comments.push(`COMMENT ON TRIGGER ${ident(tr.name)} ON ${name} IS ${lit(tr.comment)};`);
  if (comments.length) out.push('', ...comments);

  out.push('', `ALTER ${t.kind === 'foreign_table' ? 'FOREIGN TABLE' : 'TABLE'} ${name} OWNER TO ${ident(t.owner)};`);
  const grants = grantStatements(name, 'TABLE ', t.owner, t.grants);
  if (grants.length) out.push(...grants);
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ object introspection

async function loadDependents(connId: string, db: string, oid: number) {
  return jrows<DependencyRef>(connId, db, `
    SELECT DISTINCT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, ${relkindSql} AS kind
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = $1 AND c.oid <> $1
     ORDER BY 2, 3`, [oid]);
}

async function loadDependsOn(connId: string, db: string, oid: number) {
  return jrows<DependencyRef>(connId, db, `
    SELECT DISTINCT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, ${relkindSql} AS kind
      FROM pg_rewrite r
      JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
      JOIN pg_class c ON c.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE r.ev_class = $1 AND c.oid <> $1
     ORDER BY 2, 3`, [oid]);
}

async function loadTypeUsage(connId: string, db: string, typeOid: number) {
  return jrows<TypeUsage>(connId, db, `
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, ${relkindSql} AS kind
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE a.atttypid IN ($1, (SELECT typarray FROM pg_type WHERE oid = $1)) AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relkind IN ('r','p','v','m','f','c') AND NOT c.relispartition
     ORDER BY 1, 2, a.attnum`, [typeOid]);
}

const ownerComment = (owner: string, comment: string | null, objType: string, target: string) => {
  const out: string[] = [];
  if (comment) out.push(`COMMENT ON ${objType} ${target} IS ${lit(comment)};`);
  out.push(`ALTER ${objType} ${target} OWNER TO ${ident(owner)};`);
  return out;
};

async function loadView(connId: string, db: string, oid: number): Promise<ViewDetails> {
  const v = await jrow<any>(connId, db, `
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, ${relkindSql} AS kind, pg_get_userbyid(c.relowner) AS owner,
           obj_description(c.oid, 'pg_class') AS comment, pg_get_viewdef(c.oid, true) AS definition,
           CASE WHEN c.relkind = 'm' THEN c.relispopulated END AS "isPopulated",
           CASE WHEN c.relkind = 'm' THEN pg_total_relation_size(c.oid)::float8 END AS "sizeBytes",
           COALESCE(c.reloptions, ARRAY[]::text[]) AS options
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1 AND c.relkind IN ('v','m')`, [oid]);
  if (!v) throw new HttpError(404, 'View not found');
  const [columns, dependents, dependsOn, indexes, grants] = await Promise.all([
    jrows<ViewDetails['columns'][number]>(connId, db, `
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS "dataType", col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [oid]),
    loadDependents(connId, db, oid),
    loadDependsOn(connId, db, oid),
    v.kind === 'materialized_view' ? loadIndexes(connId, db, oid) : Promise.resolve([] as IndexDetail[]),
    jrows<GrantDetail>(connId, db, GRANTS_SQL('c.relacl', 'r', 'c.relowner', 'pg_class c') + ' WHERE c.oid = $1 ORDER BY 1, 3', [oid]),
  ]);
  const name = qn(v.schema, v.name);
  const isMat = v.kind === 'materialized_view';
  const def = String(v.definition).trim().replace(/;$/, '');
  const ddl: string[] = [];
  const opts = v.options.length ? ` WITH (${v.options.join(', ')})` : '';
  ddl.push(isMat ? `CREATE MATERIALIZED VIEW ${name}${opts} AS\n${def}\nWITH ${v.isPopulated ? '' : 'NO '}DATA;` : `CREATE OR REPLACE VIEW ${name}${opts} AS\n${def};`);
  if (indexes.length) ddl.push('', ...indexes.map((i) => i.definition + ';'));
  const objType = isMat ? 'MATERIALIZED VIEW' : 'VIEW';
  ddl.push('');
  if (v.comment) ddl.push(`COMMENT ON ${objType} ${name} IS ${lit(v.comment)};`);
  for (const c of columns) if (c.comment) ddl.push(`COMMENT ON COLUMN ${name}.${ident(c.name)} IS ${lit(c.comment)};`);
  ddl.push(`ALTER ${objType} ${name} OWNER TO ${ident(v.owner)};`);
  ddl.push(...grantStatements(name, 'TABLE ', v.owner, grants));
  const { options: _o, ...rest } = v;
  return { ...rest, definition: def, columns, dependents, dependsOn, indexes, grants, ddl: ddl.join('\n') + '\n' };
}

async function loadFunction(connId: string, db: string, oid: number): Promise<FunctionDetails> {
  const f = await jrow<any>(connId, db, `
    SELECT p.oid::int AS oid, n.nspname AS schema, p.proname AS name,
           CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END AS kind,
           pg_get_userbyid(p.proowner) AS owner, obj_description(p.oid, 'pg_proc') AS comment,
           pg_get_function_identity_arguments(p.oid) AS "identityArgs", pg_get_function_arguments(p.oid) AS arguments,
           pg_get_function_result(p.oid) AS result, l.lanname AS language,
           CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
           p.proisstrict AS strict, p.prosecdef AS "securityDefiner", p.proleakproof AS leakproof,
           CASE p.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' ELSE 'unsafe' END AS parallel,
           p.procost::float8 AS cost, CASE WHEN p.proretset THEN p.prorows::float8 END AS rows,
           COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
           CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END AS definition,
           COALESCE(p.proargmodes::text[], ARRAY[]::text[]) AS modes,
           COALESCE(p.proargnames, ARRAY[]::text[]) AS names,
           ARRAY(SELECT format_type(t, NULL) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) t) AS types,
           p.pronargdefaults::int AS ndefaults, pg_get_expr(p.proargdefaults, 0) AS defaults
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = $1`, [oid]);
  if (!f) throw new HttpError(404, 'Function not found');
  const [usedByTriggers, grants] = await Promise.all([
    jrows<FunctionDetails['usedByTriggers'][number]>(connId, db, `
      SELECT n.nspname AS schema, c.relname AS table, t.tgname AS trigger
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE t.tgfoid = $1 AND NOT t.tgisinternal AND t.tgparentid = 0 ORDER BY 1, 2, 3`, [oid]),
    jrows<GrantDetail>(connId, db, GRANTS_SQL('p.proacl', 'f', 'p.proowner', 'pg_proc p') + ' WHERE p.oid = $1 ORDER BY 1, 3', [oid]),
  ]);
  // parameters
  const MODE: Record<string, FunctionDetails['params'][number]['mode']> = { i: 'IN', o: 'OUT', b: 'INOUT', v: 'VARIADIC', t: 'TABLE' };
  const defaults = splitTopLevel(f.defaults ?? '');
  const inputIdx: number[] = [];
  const params = (f.types as string[]).map((type, i) => {
    const mode = MODE[f.modes[i] ?? 'i'] ?? 'IN';
    if (mode === 'IN' || mode === 'INOUT' || mode === 'VARIADIC') inputIdx.push(i);
    return { mode, name: f.names[i] || null, type, default: null as string | null };
  });
  const firstDefault = inputIdx.length - defaults.length;
  defaults.forEach((d, k) => { const i = inputIdx[firstDefault + k]; if (i != null) params[i].default = d; });

  const sig = `${qn(f.schema, f.name)}(${f.identityArgs})`;
  const objType = f.kind === 'procedure' ? 'PROCEDURE' : f.kind === 'aggregate' ? 'AGGREGATE' : 'FUNCTION';
  let ddl: string;
  if (f.definition) {
    ddl = String(f.definition).trimEnd() + ';\n';
  } else {
    const agg = await jrow<any>(connId, db, `
      SELECT a.aggtransfn::regproc::text AS sfunc, format_type(a.aggtranstype, NULL) AS stype,
             NULLIF(a.aggfinalfn::oid, 0)::regproc::text AS ffunc, a.agginitval AS initcond,
             NULLIF(a.aggcombinefn::oid, 0)::regproc::text AS combinefunc
        FROM pg_aggregate a WHERE a.aggfnoid = $1`, [oid]);
    const parts = [`    SFUNC = ${agg?.sfunc}`, `    STYPE = ${agg?.stype}`];
    if (agg?.ffunc) parts.push(`    FINALFUNC = ${agg.ffunc}`);
    if (agg?.combinefunc) parts.push(`    COMBINEFUNC = ${agg.combinefunc}`);
    if (agg?.initcond != null) parts.push(`    INITCOND = ${lit(agg.initcond)}`);
    ddl = `CREATE AGGREGATE ${sig} (\n${parts.join(',\n')}\n);\n`;
  }
  ddl += '\n' + [...ownerComment(f.owner, f.comment, objType, sig), ...grantStatements(sig, objType + ' ', f.owner, grants.filter((g) => !(g.grantee === 'PUBLIC' && g.privilege === 'EXECUTE')))].join('\n') + '\n';
  const { modes: _m, names: _n, types: _t, ndefaults: _nd, defaults: _d, ...rest } = f;
  return { ...rest, params, usedByTriggers, grants, ddl };
}

/** Split "1, 'a,b'::text, f(1, 2)" on top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) { if (s[i + 1] === q) { cur += s[++i]; } else q = null; } continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function loadSequence(connId: string, db: string, oid: number): Promise<SequenceDetails> {
  const s = await jrow<any>(connId, db, `
    SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, 'sequence' AS kind, pg_get_userbyid(c.relowner) AS owner,
           obj_description(c.oid, 'pg_class') AS comment, format_type(s.seqtypid, NULL) AS "dataType",
           s.seqstart::text AS start, s.seqmin::text AS min, s.seqmax::text AS max, s.seqincrement::text AS increment,
           s.seqcache::text AS cache, s.seqcycle AS cycle,
           (SELECT json_build_object('schema', tn.nspname, 'table', tc.relname, 'column', a.attname)
              FROM pg_depend d JOIN pg_class tc ON tc.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
              JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') LIMIT 1) AS "ownedBy",
           EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i') AS identity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_sequence s ON s.seqrelid = c.oid
     WHERE c.oid = $1`, [oid]);
  if (!s) throw new HttpError(404, 'Sequence not found');
  let lastValue: string | null = null;
  let isCalled = false;
  try {
    const r = await getPool(connId, db).query(`SELECT last_value::text AS v, is_called FROM ${qn(s.schema, s.name)}`);
    isCalled = !!r.rows[0]?.is_called;
    lastValue = r.rows[0]?.v ?? null;
  } catch { /* no privilege */ }
  const name = qn(s.schema, s.name);
  const ddl = [
    `CREATE SEQUENCE ${name}\n    AS ${s.dataType}\n    INCREMENT BY ${s.increment}\n    MINVALUE ${s.min}\n    MAXVALUE ${s.max}\n    START WITH ${s.start}\n    CACHE ${s.cache}\n    ${s.cycle ? '' : 'NO '}CYCLE;`,
    '',
    ...(s.ownedBy ? [`ALTER SEQUENCE ${name} OWNED BY ${qn(s.ownedBy.schema, s.ownedBy.table)}.${ident(s.ownedBy.column)};`] : []),
    ...(lastValue != null && isCalled ? [`SELECT setval('${name.replace(/'/g, "''")}', ${lastValue}, true);`] : []),
    ...ownerComment(s.owner, s.comment, 'SEQUENCE', name),
  ];
  if (s.identity) ddl.unshift(`-- Identity sequence of ${s.ownedBy ? `${s.ownedBy.table}.${s.ownedBy.column}` : 'a column'}; managed by ALTER TABLE … ALTER COLUMN.`);
  return { ...s, lastValue, isCalled, ddl: ddl.join('\n') + '\n' };
}

async function loadType(connId: string, db: string, oid: number): Promise<EnumDetails | DomainDetails | CompositeDetails> {
  const t = await jrow<any>(connId, db, `
    SELECT t.oid::int AS oid, n.nspname AS schema, t.typname AS name, t.typtype::text AS typtype,
           pg_get_userbyid(t.typowner) AS owner, obj_description(t.oid, 'pg_type') AS comment,
           format_type(t.typbasetype, t.typtypmod) AS "baseType", t.typnotnull AS "notNull", t.typdefault AS default,
           CASE WHEN t.typcollation <> 0 AND t.typcollation <> (SELECT typcollation FROM pg_type WHERE oid = t.typbasetype) THEN
             (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = t.typcollation)
           END AS collation,
           t.typrelid::int AS typrelid
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid = $1`, [oid]);
  if (!t) throw new HttpError(404, 'Type not found');
  const name = qn(t.schema, t.name);
  const usedBy = await loadTypeUsage(connId, db, oid);
  const tail = ownerComment(t.owner, t.comment, t.typtype === 'd' ? 'DOMAIN' : 'TYPE', name);
  const base = { oid: t.oid, schema: t.schema, name: t.name, owner: t.owner, comment: t.comment, usedBy };
  if (t.typtype === 'e') {
    const values = (await jrows<{ v: string }>(connId, db, `SELECT enumlabel AS v FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder`, [oid])).map((r) => r.v);
    const ddl = `CREATE TYPE ${name} AS ENUM (\n${values.map((v) => '    ' + lit(v)).join(',\n')}\n);\n\n${tail.join('\n')}\n`;
    return { ...base, kind: 'enum', values, ddl };
  }
  if (t.typtype === 'd') {
    const constraints = await jrows<DomainDetails['constraints'][number]>(connId, db, `
      SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition, convalidated AS validated
        FROM pg_constraint WHERE contypid = $1 AND contype = 'c' ORDER BY conname`, [oid]);
    let ddl = `CREATE DOMAIN ${name} AS ${t.baseType}`;
    if (t.collation) ddl += `\n    COLLATE ${t.collation}`;
    if (t.default != null) ddl += `\n    DEFAULT ${t.default}`;
    if (t.notNull) ddl += `\n    NOT NULL`;
    for (const c of constraints) ddl += `\n    CONSTRAINT ${ident(c.name)} ${c.definition}`;
    ddl += `;\n\n${tail.join('\n')}\n`;
    return { ...base, kind: 'domain', baseType: t.baseType, notNull: t.notNull, default: t.default, collation: t.collation, constraints, ddl };
  }
  const attributes = await jrows<CompositeDetails['attributes'][number]>(connId, db, `
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS "dataType", col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [t.typrelid]);
  const ddl = `CREATE TYPE ${name} AS (\n${attributes.map((a) => `    ${ident(a.name)} ${a.dataType}`).join(',\n')}\n);\n\n${tail.join('\n')}\n`;
  return { ...base, kind: 'type', attributes, ddl };
}

// ------------------------------------------------------------------ routes

const BASE_TYPES: [string, string, string?][] = [
  ['integer', 'Numeric', '4-byte integer'], ['bigint', 'Numeric', '8-byte integer'], ['smallint', 'Numeric', '2-byte integer'],
  ['numeric', 'Numeric', 'exact, numeric(p, s)'], ['real', 'Numeric', '4-byte float'], ['double precision', 'Numeric', '8-byte float'],
  ['serial', 'Numeric', 'auto-increment integer'], ['bigserial', 'Numeric', 'auto-increment bigint'],
  ['text', 'Text', 'variable unlimited length'], ['varchar', 'Text', 'varchar(n)'], ['char', 'Text', 'fixed length char(n)'], ['citext', 'Text', 'case-insensitive (extension)'],
  ['boolean', 'Boolean'],
  ['timestamptz', 'Date & time', 'timestamp with time zone'], ['timestamp', 'Date & time', 'without time zone'], ['date', 'Date & time'],
  ['time', 'Date & time'], ['timetz', 'Date & time'], ['interval', 'Date & time'],
  ['uuid', 'Other'], ['jsonb', 'JSON', 'binary JSON (recommended)'], ['json', 'JSON'], ['bytea', 'Binary'],
  ['inet', 'Network'], ['cidr', 'Network'], ['macaddr', 'Network'],
  ['money', 'Numeric'], ['xml', 'Other'], ['tsvector', 'Full-text'], ['tsquery', 'Full-text'],
  ['int4range', 'Range'], ['int8range', 'Range'], ['numrange', 'Range'], ['tstzrange', 'Range'], ['daterange', 'Range'],
  ['point', 'Geometric'], ['box', 'Geometric'], ['bit', 'Bit string'], ['varbit', 'Bit string'], ['oid', 'Other'],
  ['integer[]', 'Arrays'], ['bigint[]', 'Arrays'], ['text[]', 'Arrays'], ['uuid[]', 'Arrays'],
];

export default async function schemaRoutes(app: FastifyInstance) {
  type P = { connId: string; db: string };
  const B = '/api/c/:connId/db/:db/schema';

  app.get<{ Params: P & { schema: string; table: string } }>(`${B}/tables/:schema/:table`, async (req) => {
    const { connId, db, schema, table } = req.params;
    return loadTable(connId, db, schema, table);
  });

  app.get<{ Params: P & { schema: string; table: string } }>(`${B}/tables/:schema/:table/ddl`, async (req) => {
    const { connId, db, schema, table } = req.params;
    const rel = await relOid(connId, db, schema, table);
    if (rel.relkind === 'v' || rel.relkind === 'm') return { ddl: (await loadView(connId, db, rel.oid)).ddl };
    if (rel.relkind === 'S') return { ddl: (await loadSequence(connId, db, rel.oid)).ddl };
    return { ddl: tableDdl(await loadTable(connId, db, schema, table)) };
  });

  app.get<{ Params: P & { kind: string; oid: string } }>(`${B}/objects/:kind/:oid`, async (req): Promise<ObjectDetails> => {
    const { connId, db, kind } = req.params;
    const oid = Number(req.params.oid);
    if (!Number.isFinite(oid)) throw new HttpError(400, 'Invalid oid');
    switch (kind) {
      case 'view': case 'materialized_view': return loadView(connId, db, oid);
      case 'function': case 'procedure': case 'aggregate': return loadFunction(connId, db, oid);
      case 'sequence': return loadSequence(connId, db, oid);
      case 'enum': case 'domain': case 'type': return loadType(connId, db, oid);
      default: throw new HttpError(400, `Unsupported object kind ${kind}`);
    }
  });

  /** Resolve an object by schema + name (+ kind) when the oid is unknown. */
  app.get<{ Params: P; Querystring: { schema: string; name: string; kind: string } }>(`${B}/resolve`, async (req) => {
    const { connId, db } = req.params;
    const { schema, name, kind } = req.query;
    let r: { oid: number } | undefined;
    if (['function', 'procedure', 'aggregate'].includes(kind)) {
      r = await jrow(connId, db, `SELECT p.oid::int AS oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid LIMIT 1`, [schema, name]);
    } else if (['enum', 'domain', 'type'].includes(kind)) {
      r = await jrow(connId, db, `SELECT t.oid::int AS oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`, [schema, name]);
    } else {
      r = await jrow(connId, db, `SELECT c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
    }
    if (!r) throw new HttpError(404, `${schema}.${name} not found`);
    return r;
  });

  app.get<{ Params: P }>(`${B}/extensions`, async (req): Promise<ExtensionInfo[]> => {
    const { connId, db } = req.params;
    return jrows<ExtensionInfo>(connId, db, `
      SELECT a.name, e.extversion AS "installedVersion", a.default_version AS "defaultVersion", n.nspname AS schema, a.comment
        FROM pg_available_extensions a
        LEFT JOIN pg_extension e ON e.extname = a.name
        LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
      UNION ALL
      SELECT e.extname, e.extversion, NULL, n.nspname, obj_description(e.oid, 'pg_extension')
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE NOT EXISTS (SELECT 1 FROM pg_available_extensions a WHERE a.name = e.extname)
      ORDER BY 1`);
  });

  app.get<{ Params: P }>(`${B}/types`, async (req): Promise<TypeSuggestion[]> => {
    const { connId, db } = req.params;
    const user = await jrows<{ schema: string; name: string; typtype: string; comment: string | null; base: string | null }>(connId, db, `
      SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS typtype, obj_description(t.oid, 'pg_type') AS comment,
             CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
         AND (t.typtype IN ('e','d','r') OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
              OR (t.typtype = 'b' AND t.typcategory <> 'A' AND n.nspname <> 'public' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e'))
              OR (t.typtype = 'b' AND t.typcategory <> 'A' AND n.nspname = 'public'))
       ORDER BY 1, 2`);
    const KIND: Record<string, TypeSuggestion['kind']> = { e: 'enum', d: 'domain', c: 'composite', r: 'range', b: 'base' };
    const userTypes: TypeSuggestion[] = user.map((t) => ({
      name: t.schema === 'public' ? ident(t.name) : qn(t.schema, t.name),
      kind: KIND[t.typtype] ?? 'base',
      group: t.schema,
      description: t.typtype === 'd' ? `domain over ${t.base}` : t.typtype === 'e' ? 'enum' : t.typtype === 'c' ? 'composite' : t.comment ?? undefined,
    }));
    return [...userTypes, ...BASE_TYPES.map(([name, group, description]) => ({ name, group, description, kind: 'base' as const }))];
  });

  /** Execute DDL statements (optionally in one transaction). Errors carry statementIndex. */
  app.post<{ Params: P; Body: ApplyRequest }>(`${B}/apply`, async (req, reply) => {
    const { connId, db } = req.params;
    const { statements, transaction = true } = req.body ?? ({} as ApplyRequest);
    if (!Array.isArray(statements) || statements.length === 0 || statements.some((s) => typeof s !== 'string')) {
      throw new HttpError(400, 'statements must be a non-empty array of strings');
    }
    const t0 = performance.now();
    let idx = 0;
    const run = async (client: pg.PoolClient) => {
      for (idx = 0; idx < statements.length; idx++) await client.query(statements[idx]);
    };
    try {
      if (transaction && statements.length > 1) await withTransaction(connId, db, run);
      else await withClient(connId, db, run);
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      return reply.status(400).send({ error: { ...toQueryError(e), statementIndex: statements.length > 1 ? idx : undefined } });
    }
    return { ok: true, durationMs: performance.now() - t0 };
  });
}

export { RELKIND };
