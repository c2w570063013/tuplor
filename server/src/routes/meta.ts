import type { FastifyInstance } from 'fastify';
import type { ColumnInfo, DbObject, SchemaInfo } from '../../../shared/types';
import { queryRows } from '../db';

/**
 * Core catalog endpoints used by the explorer tree and many features.
 * Prefix: /api/c/:connId/db/:db/meta
 */
export default async function metaRoutes(app: FastifyInstance) {
  type P = { connId: string; db: string };

  app.get<{ Params: P; Querystring: { system?: string } }>('/api/c/:connId/db/:db/meta/schemas', async (req) => {
    const rows = await queryRows<SchemaInfo>(req.params.connId, req.params.db, `
      SELECT n.nspname AS name,
             pg_get_userbyid(n.nspowner) AS owner,
             (n.nspname IN ('pg_catalog','information_schema','pg_toast') OR n.nspname LIKE 'pg_temp_%' OR n.nspname LIKE 'pg_toast_temp_%') AS "isSystem",
             obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
       ORDER BY "isSystem", n.nspname = 'public' DESC, n.nspname`);
    return req.query.system === '1' ? rows : rows.filter((r) => !r.isSystem);
  });

  /** All relations / routines / types in a schema. */
  app.get<{ Params: P & { schema: string } }>('/api/c/:connId/db/:db/meta/schemas/:schema/objects', async (req) => {
    const { connId, db, schema } = req.params;
    const rels = await queryRows<DbObject>(connId, db, `
      SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name,
             CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view'
                            WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' END AS kind,
             obj_description(c.oid, 'pg_class') AS comment,
             CASE WHEN c.relkind IN ('r','m','p') THEN GREATEST(c.reltuples, 0)::float8 END AS "estRows",
             CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid) END AS "sizeBytes"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition
       ORDER BY c.relname`, [schema]);
    const routines = await queryRows<DbObject>(connId, db, `
      SELECT p.oid::int AS oid, n.nspname AS schema, p.proname AS name,
             CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END AS kind,
             pg_get_function_identity_arguments(p.oid) AS args,
             obj_description(p.oid, 'pg_proc') AS comment
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
       WHERE n.nspname = $1 AND d.objid IS NULL AND p.prokind <> 'w'
       ORDER BY p.proname, args`, [schema]);
    const types = await queryRows<DbObject>(connId, db, `
      SELECT t.oid::int AS oid, n.nspname AS schema, t.typname AS name,
             CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' ELSE 'type' END AS kind,
             obj_description(t.oid, 'pg_type') AS comment
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_depend d ON d.objid = t.oid AND d.deptype = 'e'
       WHERE n.nspname = $1 AND d.objid IS NULL
         AND (t.typtype IN ('e','d') OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
       ORDER BY t.typname`, [schema]);
    for (const r of rels) r.sizeBytes = r.sizeBytes == null ? null : Number(r.sizeBytes);
    return [...rels, ...routines, ...types];
  });

  app.get<{ Params: P & { schema: string; table: string } }>(
    '/api/c/:connId/db/:db/meta/tables/:schema/:table/columns',
    async (req) => {
      const { connId, db, schema, table } = req.params;
      return queryRows<ColumnInfo>(connId, db, `
        SELECT a.attname AS name, a.attnum::int AS attnum,
               format_type(a.atttypid, a.atttypmod) AS "dataType",
               t.typname AS "udtName",
               NOT a.attnotnull AS nullable,
               pg_get_expr(ad.adbin, ad.adrelid) AS default,
               COALESCE(a.attnum = ANY(pk.conkey), false) AS "isPrimaryKey",
               a.attidentity <> '' AS "isIdentity",
               a.attgenerated <> '' AS "isGenerated",
               col_description(a.attrelid, a.attnum) AS comment
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
          LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`, [schema, table]);
    },
  );
}
