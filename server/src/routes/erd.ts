import type { FastifyInstance } from 'fastify';
import type { ErdColumn, ErdRelation, ErdResponse, ErdTable, ErdTableKind } from '../../../shared/erd';
import { withClient } from '../db';

/**
 * ER diagram data: tables + columns + foreign keys for a set of schemas, in one round trip.
 *   GET /api/c/:connId/db/:db/erd?schemas=shop,analytics&views=1
 * Without `schemas`, every non-system schema is included.
 */

const ACTION: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const KIND: Record<string, ErdTableKind> = { r: 'table', p: 'partitioned_table', v: 'view', m: 'materialized_view', f: 'foreign_table' };

const SYSTEM_FILTER = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'`;

export default async function erdRoutes(app: FastifyInstance) {
  app.get<{ Params: { connId: string; db: string }; Querystring: { schemas?: string; views?: string } }>(
    '/api/c/:connId/db/:db/erd',
    async (req): Promise<ErdResponse> => {
      const { connId, db } = req.params;
      const wantViews = req.query.views === '1';
      const kinds = wantViews ? ['r', 'p', 'f', 'v', 'm'] : ['r', 'p', 'f'];

      return withClient(connId, db, async (client) => {
        const schemaRows = (await client.query(`
          SELECT n.nspname AS name,
                 count(c.oid) FILTER (WHERE c.relkind = ANY($1::"char"[]) AND NOT c.relispartition)::int AS tables
            FROM pg_namespace n
            LEFT JOIN pg_class c ON c.relnamespace = n.oid
            LEFT JOIN pg_depend d ON d.objid = n.oid AND d.deptype = 'e'
           WHERE ${SYSTEM_FILTER} AND d.objid IS NULL
           GROUP BY n.nspname
           ORDER BY n.nspname = 'public' DESC, n.nspname`, [kinds])).rows as { name: string; tables: number }[];

        const requested = req.query.schemas
          ? req.query.schemas.split(',').map((s) => s.trim()).filter(Boolean)
          : schemaRows.map((s) => s.name);
        const included = requested.filter((s) => schemaRows.some((r) => r.name === s));
        if (!included.length) return { schemas: schemaRows, included, tables: [], relations: [], externalRelations: 0 };

        const [tablesRes, columnsRes, fkRes, uniqRes] = await Promise.all([
          client.query(`
            SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                   obj_description(c.oid, 'pg_class') AS comment,
                   CASE WHEN c.relkind IN ('r','m','p') THEN
                     CASE WHEN c.relkind = 'p' THEN (SELECT sum(GREATEST(pc.reltuples,0)) FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhrelid WHERE i.inhparent = c.oid)
                          ELSE GREATEST(c.reltuples, 0) END
                   END::float8 AS "estRows"
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ANY($1) AND c.relkind = ANY($2::"char"[]) AND NOT c.relispartition
             ORDER BY n.nspname, c.relname`, [included, kinds]),
          client.query(`
            SELECT a.attrelid::int AS oid, a.attname AS name,
                   format_type(a.atttypid, a.atttypmod) AS type,
                   NOT a.attnotnull AS nullable,
                   COALESCE(a.attnum = ANY(pk.conkey), false) AS pk,
                   pg_get_expr(ad.adbin, ad.adrelid) AS default,
                   col_description(a.attrelid, a.attnum) AS comment
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
              LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
             WHERE n.nspname = ANY($1) AND c.relkind = ANY($2::"char"[]) AND NOT c.relispartition
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attrelid, a.attnum`, [included, kinds]),
          client.query(`
            SELECT con.conname AS name,
                   sn.nspname AS "srcSchema", sc.relname AS "srcTable",
                   tn.nspname AS "tgtSchema", tc.relname AS "tgtTable",
                   (SELECT json_agg(a.attname ORDER BY k.ord)::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS "srcCols",
                   (SELECT json_agg(a.attname ORDER BY k.ord)::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "tgtCols",
                   (SELECT bool_or(NOT a.attnotnull) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)) AS optional,
                   EXISTS (
                     SELECT 1 FROM pg_index i
                      WHERE i.indrelid = con.conrelid AND i.indisunique AND i.indpred IS NULL
                        AND (i.indkey::int2[])[0:] <@ con.conkey AND array_length(con.conkey,1) >= i.indnatts
                   ) AS "oneToOne",
                   con.confupdtype AS upd, con.confdeltype AS del
              FROM pg_constraint con
              JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
              JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
             WHERE con.contype = 'f' AND sn.nspname = ANY($1) AND con.conparentid = 0
             ORDER BY sn.nspname, sc.relname, con.conname`, [included]),
          client.query(`
            SELECT i.indrelid::int AS oid, a.attname AS name
              FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
             WHERE n.nspname = ANY($1) AND i.indisunique AND NOT i.indisprimary AND i.indnatts = 1 AND i.indpred IS NULL`, [included]),
        ]);

        const byOid = new Map<number, ErdTable>();
        const tables: ErdTable[] = tablesRes.rows.map((r: any) => {
          const t: ErdTable = {
            id: `${r.schema}.${r.name}`,
            schema: r.schema,
            name: r.name,
            kind: KIND[r.kind] ?? 'table',
            comment: r.comment,
            estRows: r.estRows == null ? null : Number(r.estRows),
            columns: [],
          };
          byOid.set(r.oid, t);
          return t;
        });
        const uniq = new Set(uniqRes.rows.map((r: any) => `${r.oid}\u0000${r.name}`));
        for (const r of columnsRes.rows as any[]) {
          const t = byOid.get(r.oid);
          if (!t) continue;
          const col: ErdColumn = {
            name: r.name, type: r.type, nullable: r.nullable, pk: r.pk, fk: false,
            unique: uniq.has(`${r.oid}\u0000${r.name}`), default: r.default, comment: r.comment,
          };
          t.columns.push(col);
        }

        const ids = new Set(tables.map((t) => t.id));
        const byId = new Map(tables.map((t) => [t.id, t]));
        const relations: ErdRelation[] = [];
        let externalRelations = 0;
        for (const r of fkRes.rows as any[]) {
          const srcCols: string[] = r.srcCols ? JSON.parse(r.srcCols) : [];
          const tgtCols: string[] = r.tgtCols ? JSON.parse(r.tgtCols) : [];
          const source = `${r.srcSchema}.${r.srcTable}`;
          const target = `${r.tgtSchema}.${r.tgtTable}`;
          const srcTable = byId.get(source);
          if (srcTable) for (const c of srcTable.columns) if (srcCols.includes(c.name)) c.fk = true;
          if (!ids.has(source)) continue;
          if (!ids.has(target)) { externalRelations++; continue; }
          relations.push({
            id: `${source}.${r.name}`,
            name: r.name,
            source,
            sourceColumns: srcCols,
            target,
            targetColumns: tgtCols,
            onUpdate: ACTION[r.upd] ?? 'NO ACTION',
            onDelete: ACTION[r.del] ?? 'NO ACTION',
            oneToOne: !!r.oneToOne,
            optional: !!r.optional,
          });
        }
        return { schemas: schemaRows, included, tables, relations, externalRelations };
      });
    },
  );
}
