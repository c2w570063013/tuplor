import type { FastifyInstance } from 'fastify';
import type {
  ActivitySession, BlockingNode, CreateDatabaseRequest, DatabaseFormMeta, DatabaseRow, DropDatabaseRequest, IndexStat,
  LockInfo, LocksResponse, MaintenanceRequest, MonitorSnapshot, ReplicaInfo, SettingRow, StatementStat,
  StatementsResponse, StatementsSort, StatementsStatus, TableStat,
} from '../../../shared/monitor';
import { closePool, queryRows } from '../db';
import { getConnectionWithSecret } from '../store';
import { HttpError } from '../lib/errors';
import { qualified, quoteIdent, quoteLiteral } from '../lib/sql';

/**
 * Monitoring & admin endpoints.
 *   Server scoped:   /api/c/:connId/monitor/...
 *   Database scoped: /api/c/:connId/db/:db/monitor/...
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const pids = (v: string | null | undefined): number[] => (v ? v.split(',').filter(Boolean).map(Number) : []);

/** Small TTL cache for expensive values polled every couple of seconds (database sizes). */
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const versionCache = new Map<string, number>();
async function serverVersion(connId: string, db?: string): Promise<number> {
  const k = connId;
  if (!versionCache.has(k)) {
    const [r] = await queryRows<{ v: number }>(connId, db, `SELECT current_setting('server_version_num')::int AS v`);
    versionCache.set(k, r.v);
  }
  return versionCache.get(k)!;
}

function assertName(name: unknown, what = 'name'): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, `Missing ${what}`);
  if (name.length > 63) throw new HttpError(400, `${what} is longer than 63 characters`);
  return name;
}

export default async function monitorRoutes(app: FastifyInstance) {
  type S = { connId: string };
  type D = { connId: string; db: string };

  // ------------------------------------------------------------------ snapshot
  app.get<{ Params: S; Querystring: { db?: string } }>('/api/c/:connId/monitor/snapshot', async (req): Promise<MonitorSnapshot> => {
    const { connId } = req.params;
    const db = req.query.db || undefined;
    const [r] = await queryRows(connId, db, `
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ts,
             version() AS version,
             current_setting('server_version_num')::int AS vnum,
             pg_postmaster_start_time()::text AS started,
             extract(epoch FROM clock_timestamp() - pg_postmaster_start_time())::float8 AS uptime,
             pg_is_in_recovery() AS rec,
             current_setting('max_connections')::int AS maxc,
             current_setting('superuser_reserved_connections')::int AS resv,
             (SELECT count(*)::int FROM pg_database WHERE NOT datistemplate) AS dbcount,
             s.*,
             c.*
        FROM (SELECT sum(xact_commit)::float8 AS xact_commit, sum(xact_rollback)::float8 AS xact_rollback,
                     sum(tup_returned)::float8 AS tup_returned, sum(tup_fetched)::float8 AS tup_fetched,
                     sum(tup_inserted)::float8 AS tup_inserted, sum(tup_updated)::float8 AS tup_updated,
                     sum(tup_deleted)::float8 AS tup_deleted, sum(blks_read)::float8 AS blks_read,
                     sum(blks_hit)::float8 AS blks_hit, sum(deadlocks)::float8 AS deadlocks,
                     sum(temp_files)::float8 AS temp_files, sum(temp_bytes)::float8 AS temp_bytes,
                     sum(conflicts)::float8 AS conflicts, min(stats_reset)::text AS stats_reset
                FROM pg_stat_database) s,
             (SELECT count(*)::int AS total,
                     count(*) FILTER (WHERE state = 'active')::int AS active,
                     count(*) FILTER (WHERE state = 'idle')::int AS idle,
                     count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_tx,
                     count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting
                FROM pg_stat_activity WHERE backend_type = 'client backend') c`);

    let walBytes: number | null = null;
    let replayLagSec: number | null = null;
    let replicas: ReplicaInfo[] = [];
    try {
      if (r.rec) {
        const [w] = await queryRows(connId, db, `
          SELECT (pg_last_wal_replay_lsn() - '0/0')::float8 AS wal,
                 extract(epoch FROM clock_timestamp() - pg_last_xact_replay_timestamp())::float8 AS lag`);
        walBytes = numOrNull(w.wal);
        replayLagSec = numOrNull(w.lag);
      } else {
        const [w] = await queryRows(connId, db, `SELECT (pg_current_wal_lsn() - '0/0')::float8 AS wal`);
        walBytes = numOrNull(w.wal);
        const reps = await queryRows(connId, db, `
          SELECT pid, application_name, host(client_addr) AS client, state, sync_state,
                 pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::float8 AS lag_bytes,
                 extract(epoch FROM replay_lag)::float8 AS lag_sec
            FROM pg_stat_replication`);
        replicas = reps.map((x) => ({
          pid: x.pid, applicationName: x.application_name, clientAddr: x.client, state: x.state, syncState: x.sync_state,
          replayLagBytes: numOrNull(x.lag_bytes), replayLagSec: numOrNull(x.lag_sec),
        }));
      }
    } catch {
      /* insufficient privilege for WAL functions: leave null */
    }

    const sizes = await cached(`sizes:${connId}:${db ?? ''}`, 30_000, async () => {
      const [z] = await queryRows(connId, db, `
        SELECT pg_database_size(current_database())::float8 AS db,
               (SELECT sum(pg_database_size(oid))::float8 FROM pg_database
                 WHERE datallowconn AND has_database_privilege(oid, 'CONNECT')) AS cluster`);
      return { db: numOrNull(z.db), cluster: numOrNull(z.cluster) };
    });

    const total = num(r.total);
    return {
      ts: num(r.ts),
      version: r.version,
      versionNum: r.vnum,
      startedAt: r.started,
      uptimeSec: num(r.uptime),
      inRecovery: r.rec,
      maxConnections: r.maxc,
      superuserReserved: r.resv,
      connections: {
        total, active: r.active, idle: r.idle, idleInTx: r.idle_tx, waiting: r.waiting,
        other: Math.max(0, total - r.active - r.idle - r.idle_tx),
      },
      dbSizeBytes: sizes.db,
      clusterSizeBytes: sizes.cluster,
      databaseCount: r.dbcount,
      counters: {
        xactCommit: num(r.xact_commit), xactRollback: num(r.xact_rollback),
        tupReturned: num(r.tup_returned), tupFetched: num(r.tup_fetched), tupInserted: num(r.tup_inserted),
        tupUpdated: num(r.tup_updated), tupDeleted: num(r.tup_deleted),
        blksRead: num(r.blks_read), blksHit: num(r.blks_hit), deadlocks: num(r.deadlocks),
        tempFiles: num(r.temp_files), tempBytes: num(r.temp_bytes), conflicts: num(r.conflicts),
      },
      walBytes,
      replayLagSec,
      replicas,
      statsReset: r.stats_reset ?? null,
    };
  });

  // ------------------------------------------------------------------ activity
  app.get<{ Params: S }>('/api/c/:connId/monitor/activity', async (req): Promise<ActivitySession[]> => {
    const rows = await queryRows(req.params.connId, undefined, `
      SELECT a.pid, a.usename, a.datname, a.application_name,
             COALESCE(host(a.client_addr) || COALESCE(':' || a.client_port, ''), a.client_hostname,
                      CASE WHEN a.client_port = -1 THEN 'local socket' END) AS client,
             a.backend_type, a.state, a.wait_event_type, a.wait_event,
             a.backend_start::text, a.xact_start::text, a.query_start::text,
             (extract(epoch FROM clock_timestamp() - a.query_start) * 1000)::float8 AS query_age,
             (extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::float8 AS xact_age,
             COALESCE(a.query, '') AS query,
             array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by,
             a.pid = pg_backend_pid() AS is_self
        FROM pg_stat_activity a
       ORDER BY (a.backend_type = 'client backend') DESC, (a.state = 'active') DESC, a.query_start NULLS LAST`);
    return rows.map((x) => ({
      pid: x.pid, user: x.usename, database: x.datname, application: x.application_name ?? '', client: x.client,
      backendType: x.backend_type, state: x.state, waitEventType: x.wait_event_type, waitEvent: x.wait_event,
      backendStart: x.backend_start, xactStart: x.xact_start, queryStart: x.query_start,
      queryAgeMs: numOrNull(x.query_age), xactAgeMs: numOrNull(x.xact_age), query: x.query,
      blockedBy: pids(x.blocked_by), isSelf: x.is_self,
    }));
  });

  app.post<{ Params: S & { pid: string }; Body: { action: 'cancel' | 'terminate' } }>(
    '/api/c/:connId/monitor/backends/:pid/signal',
    async (req) => {
      const pid = Number(req.params.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new HttpError(400, 'Invalid pid');
      const fn = req.body?.action === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend';
      const [r] = await queryRows<{ ok: boolean }>(req.params.connId, undefined, `SELECT ${fn}($1) AS ok`, [pid]);
      if (!r.ok) throw new HttpError(409, `Backend ${pid} could not be signalled (already gone, or not permitted).`);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ locks
  app.get<{ Params: S; Querystring: { db?: string } }>('/api/c/:connId/monitor/locks', async (req): Promise<LocksResponse> => {
    const { connId } = req.params;
    const db = req.query.db || undefined;
    const locks = await queryRows(connId, db, `
      SELECT l.pid, l.locktype, l.mode, l.granted, d.datname,
             CASE WHEN l.relation IS NOT NULL THEN
               CASE WHEN l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                    THEN l.relation::regclass::text ELSE 'oid ' || l.relation::text END END AS relation,
             l.page, l.tuple, l.transactionid::text AS xid, l.virtualxid,
             a.usename, a.state, COALESCE(a.query, '') AS query,
             (extract(epoch FROM clock_timestamp() - l.waitstart) * 1000)::float8 AS wait_age
        FROM pg_locks l
        LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        LEFT JOIN pg_database d ON d.oid = l.database
       WHERE l.pid IS DISTINCT FROM pg_backend_pid()
       ORDER BY l.granted, l.pid, l.locktype`);
    const blocking = await queryRows(connId, db, `
      WITH w AS (
        SELECT pid, pg_blocking_pids(pid) AS bp FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0
      )
      SELECT a.pid, a.usename, a.datname, a.application_name, a.state, a.wait_event_type || ':' || a.wait_event AS wait,
             (extract(epoch FROM clock_timestamp() - a.query_start) * 1000)::float8 AS query_age,
             (extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::float8 AS xact_age,
             COALESCE(a.query, '') AS query,
             array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by
        FROM pg_stat_activity a
       WHERE a.pid IN (SELECT pid FROM w) OR a.pid IN (SELECT unnest(bp) FROM w)
       ORDER BY a.xact_start NULLS LAST`);
    return {
      locks: locks.map((x): LockInfo => ({
        pid: x.pid, lockType: x.locktype, mode: x.mode, granted: x.granted, database: x.datname, relation: x.relation,
        page: x.page, tuple: x.tuple, transactionId: x.xid, virtualXid: x.virtualxid, user: x.usename, state: x.state,
        query: x.query, waitStartAgeMs: numOrNull(x.wait_age),
      })),
      blocking: blocking.map((x): BlockingNode => ({
        pid: x.pid, user: x.usename, database: x.datname, application: x.application_name ?? '', state: x.state,
        waitEvent: x.wait, queryAgeMs: numOrNull(x.query_age), xactAgeMs: numOrNull(x.xact_age), query: x.query,
        blockedBy: pids(x.blocked_by),
      })),
    };
  });

  // ------------------------------------------------------------------ settings
  app.get<{ Params: S }>('/api/c/:connId/monitor/settings', async (req): Promise<SettingRow[]> => {
    const rows = await queryRows(req.params.connId, undefined, `
      SELECT name, setting, unit, category, short_desc, extra_desc, context, vartype, source,
             min_val, max_val, array_to_json(enumvals)::text AS enumvals, boot_val, reset_val, pending_restart
        FROM pg_settings ORDER BY category, name`);
    return rows.map((x) => ({
      name: x.name, setting: x.setting, unit: x.unit, category: x.category, shortDesc: x.short_desc ?? '',
      extraDesc: x.extra_desc, context: x.context, vartype: x.vartype, source: x.source,
      minVal: x.min_val, maxVal: x.max_val, enumVals: x.enumvals ? JSON.parse(x.enumvals) : null,
      bootVal: x.boot_val, resetVal: x.reset_val, pendingRestart: x.pending_restart,
      display: displaySetting(x.setting, x.unit, x.vartype),
      nonDefault: x.source !== 'default' && x.source !== 'override' && x.setting !== x.boot_val,
    }));
  });

  // ------------------------------------------------------------------ databases
  app.get<{ Params: S }>('/api/c/:connId/monitor/databases', async (req): Promise<DatabaseRow[]> => {
    const rows = await queryRows(req.params.connId, undefined, `
      SELECT d.datname, d.oid::int AS oid, pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding,
             d.datcollate, d.datctype, d.datistemplate, d.datallowconn, d.datconnlimit, t.spcname,
             CASE WHEN d.datallowconn AND has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid)::float8 END AS size,
             COALESCE(s.numbackends, 0) AS conns, s.xact_commit::float8 AS commits, s.xact_rollback::float8 AS rollbacks,
             CASE WHEN s.blks_hit + s.blks_read > 0 THEN (100.0 * s.blks_hit / (s.blks_hit + s.blks_read))::float8 END AS hit,
             s.deadlocks::float8 AS deadlocks,
             shobj_description(d.oid, 'pg_database') AS comment
        FROM pg_database d
        LEFT JOIN pg_tablespace t ON t.oid = d.dattablespace
        LEFT JOIN pg_stat_database s ON s.datid = d.oid
       ORDER BY d.datistemplate, d.datname`);
    return rows.map((x) => ({
      name: x.datname, oid: x.oid, owner: x.owner, encoding: x.encoding, collate: x.datcollate, ctype: x.datctype,
      isTemplate: x.datistemplate, allowConn: x.datallowconn, connLimit: x.datconnlimit, tablespace: x.spcname,
      sizeBytes: numOrNull(x.size), connections: num(x.conns), xactCommit: num(x.commits), xactRollback: num(x.rollbacks),
      cacheHitPct: numOrNull(x.hit), deadlocks: num(x.deadlocks), comment: x.comment,
    }));
  });

  app.get<{ Params: S }>('/api/c/:connId/monitor/databases/meta', async (req): Promise<DatabaseFormMeta> => {
    const { connId } = req.params;
    const [roles, templates, spcs, me] = await Promise.all([
      queryRows<{ n: string }>(connId, undefined, `SELECT rolname AS n FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`),
      queryRows<{ n: string }>(connId, undefined, `SELECT datname AS n FROM pg_database WHERE datistemplate OR datallowconn ORDER BY datistemplate DESC, 1`),
      queryRows<{ n: string }>(connId, undefined, `SELECT spcname AS n FROM pg_tablespace ORDER BY 1`),
      queryRows<{ n: string }>(connId, undefined, `SELECT current_user AS n`),
    ]);
    return {
      roles: roles.map((r) => r.n),
      templates: templates.map((r) => r.n),
      tablespaces: spcs.map((r) => r.n),
      encodings: ['UTF8', 'SQL_ASCII', 'LATIN1', 'LATIN2', 'LATIN9', 'WIN1252', 'EUC_JP', 'EUC_KR', 'EUC_CN', 'EUC_TW', 'KOI8R', 'ISO_8859_5', 'WIN1251'],
      currentUser: me[0].n,
    };
  });

  app.post<{ Params: S; Body: CreateDatabaseRequest }>('/api/c/:connId/monitor/databases', async (req) => {
    const b = req.body ?? ({} as CreateDatabaseRequest);
    const name = assertName(b.name, 'database name');
    const opts: string[] = [];
    if (b.owner) opts.push(`OWNER = ${quoteIdent(b.owner)}`);
    if (b.template) opts.push(`TEMPLATE = ${quoteIdent(b.template)}`);
    if (b.encoding) opts.push(`ENCODING = ${quoteLiteral(b.encoding)}`);
    if (b.locale) opts.push(`LOCALE = ${quoteLiteral(b.locale)}`);
    if (b.tablespace) opts.push(`TABLESPACE = ${quoteIdent(b.tablespace)}`);
    if (b.connLimit != null && Number.isInteger(b.connLimit) && b.connLimit !== -1) opts.push(`CONNECTION LIMIT = ${b.connLimit}`);
    const stmts = [`CREATE DATABASE ${quoteIdent(name)}${opts.length ? '\n  WITH ' + opts.join('\n       ') : ''};`];
    if (b.comment) stmts.push(`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(b.comment)};`);
    const sql = stmts.join('\n');
    if (b.dryRun) return { sql };
    // CREATE DATABASE cannot run inside a (implicit) transaction block: one statement per round trip.
    for (const s of stmts) await queryRows(req.params.connId, undefined, s);
    return { sql, ok: true };
  });

  app.post<{ Params: S; Body: DropDatabaseRequest }>('/api/c/:connId/monitor/databases/drop', async (req) => {
    const { connId } = req.params;
    const b = req.body ?? ({} as DropDatabaseRequest);
    const name = assertName(b.name, 'database name');
    const sql = `DROP DATABASE ${quoteIdent(name)}${b.force ? ' WITH (FORCE)' : ''};`;
    if (b.dryRun) return { sql };
    const conn = getConnectionWithSecret(connId);
    if (!conn) throw new HttpError(404, `Unknown connection ${connId}`);
    // Run from a different database than the one being dropped, and release our own connections to it.
    const via = conn.database !== name ? conn.database : name !== 'postgres' ? 'postgres' : 'template1';
    await closePool(connId, name);
    await queryRows(connId, via, sql);
    return { sql, ok: true };
  });

  // ------------------------------------------------------------------ tables & indexes (database scoped)
  app.get<{ Params: D }>('/api/c/:connId/db/:db/monitor/tables', async (req): Promise<TableStat[]> => {
    const rows = await queryRows(req.params.connId, req.params.db, `
      WITH w AS (
        SELECT schemaname, tablename, sum((1 - COALESCE(null_frac, 0)) * COALESCE(avg_width, 0))::float8 AS width
          FROM pg_stats GROUP BY 1, 2
      )
      SELECT s.schemaname, s.relname,
             pg_total_relation_size(s.relid)::float8 AS total, pg_relation_size(s.relid)::float8 AS heap,
             pg_indexes_size(s.relid)::float8 AS idx,
             COALESCE(pg_total_relation_size(c.reltoastrelid), 0)::float8 AS toast,
             s.n_live_tup::float8 AS live, s.n_dead_tup::float8 AS dead,
             s.seq_scan::float8 AS seq, COALESCE(s.idx_scan, 0)::float8 AS idxs,
             s.n_tup_ins::float8 AS ins, s.n_tup_upd::float8 AS upd, s.n_tup_del::float8 AS del, s.n_tup_hot_upd::float8 AS hot,
             s.last_vacuum::text, s.last_autovacuum::text, s.last_analyze::text, s.last_autoanalyze::text,
             s.vacuum_count::float8 AS vc, s.autovacuum_count::float8 AS avc,
             c.relpages::float8 AS relpages, GREATEST(c.reltuples, 0)::float8 AS reltuples, w.width,
             current_setting('block_size')::int AS bs,
             COALESCE((SELECT substring(o FROM 'fillfactor=([0-9]+)')::int FROM unnest(c.reloptions) o WHERE o LIKE 'fillfactor=%'), 100) AS ff
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
        LEFT JOIN w ON w.schemaname = s.schemaname AND w.tablename = s.relname
       ORDER BY total DESC`);
    return rows.map((x) => {
      const live = num(x.live);
      const dead = num(x.dead);
      let bloatBytes: number | null = null;
      let bloatPct: number | null = null;
      const heap = num(x.heap);
      if (x.width != null && num(x.relpages) > 0) {
        // Heuristic (à la ioguix): expected pages = tuples × (header + item pointer + data) / usable page space
        const tupleBytes = 24 + 4 + num(x.width);
        const usable = (x.bs * x.ff) / 100 - 24;
        const expectedPages = Math.ceil((num(x.reltuples) * tupleBytes) / usable);
        const extra = Math.max(0, num(x.relpages) - expectedPages);
        bloatBytes = extra * x.bs;
        bloatPct = heap > 0 ? Math.min(100, (bloatBytes / heap) * 100) : 0;
      }
      return {
        schema: x.schemaname, name: x.relname, totalBytes: num(x.total), tableBytes: heap, indexBytes: num(x.idx),
        toastBytes: num(x.toast), liveTuples: live, deadTuples: dead,
        deadPct: live + dead > 0 ? (dead / (live + dead)) * 100 : 0,
        seqScan: num(x.seq), idxScan: num(x.idxs), inserts: num(x.ins), updates: num(x.upd), deletes: num(x.del), hotUpdates: num(x.hot),
        lastVacuum: x.last_vacuum, lastAutovacuum: x.last_autovacuum, lastAnalyze: x.last_analyze, lastAutoanalyze: x.last_autoanalyze,
        vacuumCount: num(x.vc), autovacuumCount: num(x.avc), bloatBytes, bloatPct,
      };
    });
  });

  app.get<{ Params: D }>('/api/c/:connId/db/:db/monitor/indexes', async (req): Promise<IndexStat[]> => {
    const rows = await queryRows(req.params.connId, req.params.db, `
      SELECT s.schemaname, s.relname, s.indexrelname, s.indexrelid::int AS oid,
             pg_relation_size(s.indexrelid)::float8 AS size,
             s.idx_scan::float8 AS scans, s.idx_tup_read::float8 AS tread, s.idx_tup_fetch::float8 AS tfetch,
             i.indisunique, i.indisprimary, i.indisvalid,
             pg_get_indexdef(s.indexrelid) AS def,
             (i.indrelid::text || '|' || i.indkey::text || '|' || i.indclass::text || '|' || COALESCE(pg_get_expr(i.indexprs, i.indrelid), '')
               || '|' || COALESCE(pg_get_expr(i.indpred, i.indrelid), '') || '|' || am.amname) AS sig,
             EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = s.indexrelid) AS backs_constraint
        FROM pg_stat_user_indexes s
        JOIN pg_index i ON i.indexrelid = s.indexrelid
        JOIN pg_class ic ON ic.oid = s.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
       ORDER BY size DESC`);
    const bySig = new Map<string, string[]>();
    for (const x of rows) bySig.set(x.sig, [...(bySig.get(x.sig) ?? []), x.indexrelname]);
    return rows.map((x) => ({
      schema: x.schemaname, table: x.relname, name: x.indexrelname, sizeBytes: num(x.size), scans: num(x.scans),
      tupRead: num(x.tread), tupFetched: num(x.tfetch), isUnique: x.indisunique, isPrimary: x.indisprimary, isValid: x.indisvalid,
      definition: x.def,
      duplicateOf: (bySig.get(x.sig) ?? []).filter((n) => n !== x.indexrelname),
      unused: num(x.scans) === 0 && !x.indisunique && !x.indisprimary && !x.backs_constraint,
    }));
  });

  app.post<{ Params: D; Body: MaintenanceRequest }>('/api/c/:connId/db/:db/monitor/maintenance', async (req) => {
    const b = req.body ?? ({} as MaintenanceRequest);
    const target = qualified(assertName(b.schema, 'schema'), assertName(b.name));
    let sql: string;
    switch (b.op) {
      case 'VACUUM': sql = `VACUUM ${target};`; break;
      case 'VACUUM ANALYZE': sql = `VACUUM (ANALYZE) ${target};`; break;
      case 'VACUUM FULL': sql = `VACUUM (FULL, ANALYZE) ${target};`; break;
      case 'ANALYZE': sql = `ANALYZE ${target};`; break;
      case 'REINDEX': sql = `REINDEX ${b.kind === 'index' ? 'INDEX' : 'TABLE'} ${target};`; break;
      default: throw new HttpError(400, 'Unknown maintenance operation');
    }
    if (b.dryRun) return { sql };
    const t0 = Date.now();
    await queryRows(req.params.connId, req.params.db, sql);
    return { sql, ok: true, durationMs: Date.now() - t0 };
  });

  // ------------------------------------------------------------------ pg_stat_statements (database scoped)
  async function statementsStatus(connId: string, db: string): Promise<StatementsStatus> {
    const [r] = await queryRows(connId, db, `
      SELECT (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
             EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available,
             current_setting('shared_preload_libraries') AS preload,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
               OR has_database_privilege(current_database(), 'CREATE') AS can_create`);
    const preloaded = String(r.preload ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).includes('pg_stat_statements');
    return { installed: r.installed != null, version: r.installed ?? undefined, available: r.available, preloaded, canCreate: !!r.can_create };
  }

  app.get<{ Params: D; Querystring: { sort?: StatementsSort; limit?: string; scope?: 'db' | 'all' } }>(
    '/api/c/:connId/db/:db/monitor/statements',
    async (req): Promise<StatementsResponse> => {
      const { connId, db } = req.params;
      const status = await statementsStatus(connId, db);
      if (!status.installed) return { status, rows: [] };
      const v = await serverVersion(connId, db);
      const t = v >= 130000 ? 'exec_time' : 'time';
      const order: Record<StatementsSort, string> = {
        total: `total_${t}`, mean: `mean_${t}`, calls: 'calls', rows: 'rows', io: 'shared_blks_read',
      };
      const sort = order[req.query.sort ?? 'total'] ?? order.total;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      try {
        const rows = await queryRows(connId, db, `
          SELECT s.queryid::text AS qid, s.query, r.rolname, d.datname, s.calls::float8 AS calls,
                 s.total_${t}::float8 AS total, s.mean_${t}::float8 AS mean, s.min_${t}::float8 AS min,
                 s.max_${t}::float8 AS max, s.stddev_${t}::float8 AS stddev, s.rows::float8 AS rows,
                 s.shared_blks_hit::float8 AS hit, s.shared_blks_read::float8 AS read,
                 (100 * s.total_${t} / NULLIF(sum(s.total_${t}) OVER (), 0))::float8 AS pct
            FROM pg_stat_statements s
            LEFT JOIN pg_roles r ON r.oid = s.userid
            LEFT JOIN pg_database d ON d.oid = s.dbid
           ${req.query.scope === 'db' ? 'WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())' : ''}
           ORDER BY ${sort} DESC NULLS LAST
           LIMIT ${limit}`);
        return {
          status,
          rows: rows.map((x): StatementStat => ({
            queryId: x.qid, query: x.query ?? '', user: x.rolname, database: x.datname, calls: num(x.calls),
            totalMs: num(x.total), meanMs: num(x.mean), minMs: num(x.min), maxMs: num(x.max), stddevMs: num(x.stddev),
            rows: num(x.rows), sharedBlksHit: num(x.hit), sharedBlksRead: num(x.read),
            hitPct: num(x.hit) + num(x.read) > 0 ? (100 * num(x.hit)) / (num(x.hit) + num(x.read)) : null,
            pctTotal: num(x.pct),
          })),
        };
      } catch (e: any) {
        return { status: { ...status, error: e.message }, rows: [] };
      }
    },
  );

  app.post<{ Params: D }>('/api/c/:connId/db/:db/monitor/statements/reset', async (req) => {
    await queryRows(req.params.connId, req.params.db, `SELECT pg_stat_statements_reset()`);
    return { ok: true };
  });

  app.post<{ Params: D }>('/api/c/:connId/db/:db/monitor/statements/install', async (req) => {
    await queryRows(req.params.connId, req.params.db, `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    return { ok: true };
  });
}

/** Render a pg_settings value with its unit in human terms ("128 MB", "5 s"). */
function displaySetting(setting: string, unit: string | null, vartype: string): string {
  if (!unit || (vartype !== 'integer' && vartype !== 'real')) return setting;
  const v = Number(setting);
  if (!Number.isFinite(v)) return `${setting} ${unit}`;
  if (v < 0) return setting; // -1 = disabled / use another setting
  const mem = /^(\d*)(B|kB|MB|GB|TB)$/.exec(unit);
  if (mem) {
    const mult = Number(mem[1] || 1) * { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[mem[2] as 'B'];
    let b = v * mult;
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && b % 1024 === 0 && i < units.length - 1) { b /= 1024; i++; }
    if (b >= 1024 && i < units.length - 1) {
      while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
      return `${b.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
    }
    return `${b} ${units[i]}`;
  }
  const time = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 'ms'];
  if (time) {
    if (v === 0) return `0 ${unit}`;
    let ms = v * time;
    for (const [u, f] of [['d', 86_400_000], ['h', 3_600_000], ['min', 60_000], ['s', 1000]] as const) {
      if (ms >= f && ms % f === 0) return `${ms / f} ${u}`;
    }
    return ms < 1 ? `${ms * 1000} us` : `${ms} ms`;
  }
  return `${setting} ${unit}`;
}
