import pg from 'pg';
import type { ConnectionConfig } from '../../shared/types';
import { getConnectionWithSecret } from './store';
import { HttpError } from './lib/errors';

/**
 * Connection pools & persistent sessions.
 *
 * - One pg.Pool per (connectionId, database), created lazily.
 * - Editor sessions: one dedicated pg.Client per sessionId (per SQL tab), so
 *   BEGIN/SET/temp tables persist across runs. Idle sessions are closed after 30 min.
 * - Values: we keep PostgreSQL's own text output for everything except
 *   bool -> boolean and int2/int4/oid -> number. int8/numeric/float stay strings
 *   (no precision loss; NaN/Infinity survive JSON), timestamps keep server formatting,
 *   json/jsonb stay as their text, bytea as "\\x..." hex, arrays as "{...}".
 */

const identity = (v: string) => v;
const TYPE_PARSERS: Record<number, (v: string) => unknown> = {
  16: (v) => v === 't',          // bool
  21: (v) => parseInt(v, 10),     // int2
  23: (v) => parseInt(v, 10),     // int4
  26: (v) => parseInt(v, 10),     // oid
};

export const textTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format === 'binary') return identity as any;
    return (TYPE_PARSERS[oid] ?? identity) as any;
  },
};

/**
 * sslmode=prefer (libpq's default) means "try SSL, fall back to plaintext if the server has none".
 * node-pg has no such mode, so we try SSL first and remember the host:port endpoints that refused it.
 */
const noSslEndpoints = new Set<string>();
const endpoint = (c: ConnectionConfig) => `${c.host}:${c.port}`;

export function isSslUnsupportedError(e: unknown): boolean {
  return /does not support SSL/i.test((e as Error)?.message ?? '');
}

/** If `e` is a prefer-mode SSL refusal, remember the endpoint and return true (caller should retry). */
function shouldRetryWithoutSsl(c: ConnectionConfig, e: unknown): boolean {
  if (c.sslMode !== 'prefer' || !isSslUnsupportedError(e) || noSslEndpoints.has(endpoint(c))) return false;
  noSslEndpoints.add(endpoint(c));
  return true;
}

export function clientConfig(c: ConnectionConfig, database?: string): pg.ClientConfig {
  let ssl: pg.ClientConfig['ssl'] = false;
  switch (c.sslMode) {
    case 'prefer':
      // Unix sockets never use SSL; otherwise try SSL unless this endpoint already refused it.
      if (!c.host.startsWith('/') && !noSslEndpoints.has(endpoint(c))) ssl = { rejectUnauthorized: false };
      break;
    case 'require':
      ssl = { rejectUnauthorized: false };
      break;
    case 'verify-ca':
    case 'verify-full':
      ssl = { rejectUnauthorized: true };
      break;
  }
  const options: string[] = [];
  if (c.readOnly) options.push('-c default_transaction_read_only=on');
  if (c.statementTimeoutMs) options.push(`-c statement_timeout=${Math.floor(c.statementTimeoutMs)}`);
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: database || c.database,
    ssl,
    options: options.length ? options.join(' ') : undefined,
    application_name: 'PG Studio',
    connectionTimeoutMillis: 10_000,
    types: textTypes as any,
  };
}

/** Open a standalone client, applying the sslmode=prefer fallback. Caller must `end()` it. */
export async function connectClient(c: ConnectionConfig, database?: string): Promise<pg.Client> {
  const client = new pg.Client(clientConfig(c, database));
  try {
    await client.connect();
    return client;
  } catch (e) {
    client.end().catch(() => {});
    if (!shouldRetryWithoutSsl(c, e)) throw e;
    const plain = new pg.Client(clientConfig(c, database));
    await plain.connect();
    return plain;
  }
}

/** pg.Pool that applies the sslmode=prefer fallback to every new physical connection. */
class PreferSslPool extends pg.Pool {
  constructor(private conn: ConnectionConfig, database: string) {
    super({ ...clientConfig(conn, database), max: 6, idleTimeoutMillis: 60_000 });
    // New clients read the (possibly updated) SSL decision at construction time.
    const self = this as any;
    const Base = self.Client as typeof pg.Client;
    self.Client = class extends Base {
      constructor(cfg: pg.ClientConfig) {
        // pg-pool stores `password` as a non-enumerable property, so copy it explicitly.
        super(conn.sslMode === 'prefer' && noSslEndpoints.has(endpoint(conn)) ? { ...cfg, password: cfg.password, ssl: false } : cfg);
      }
    };
  }

  // pool.query() goes through connect(callback), so overriding connect covers every path.
  connect(cb?: any): any {
    if (cb) {
      return super.connect(((err: Error | undefined, client: any, done: any) =>
        err && shouldRetryWithoutSsl(this.conn, err) ? super.connect(cb) : cb(err, client, done)) as any);
    }
    return super.connect().catch((e) => {
      if (shouldRetryWithoutSsl(this.conn, e)) return super.connect();
      throw e;
    });
  }
}

function requireConn(connId: string): ConnectionConfig {
  const c = getConnectionWithSecret(connId);
  if (!c) throw new HttpError(404, `Unknown connection ${connId}`);
  return c;
}

const pools = new Map<string, pg.Pool>();

export function getPool(connId: string, database?: string): pg.Pool {
  const conn = requireConn(connId);
  const db = database || conn.database;
  const key = `${connId}\u0000${db}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = new PreferSslPool(conn, db);
    pool.on('error', () => { /* idle client errors: ignore, pool replaces them */ });
    pools.set(key, pool);
  }
  return pool;
}

/** Close all pools and sessions for a connection (on disconnect / edit / delete). */
export async function closeConnection(connId: string): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const [key, pool] of pools) {
    if (key.startsWith(connId + '\u0000')) {
      pools.delete(key);
      tasks.push(pool.end().catch(() => {}));
    }
  }
  for (const [id, s] of sessions) {
    if (s.connId === connId) tasks.push(closeSession(id));
  }
  await Promise.all(tasks);
}

/** Close the pool for one (connection, database) — e.g. before DROP DATABASE. Sessions on it are closed too. */
export async function closePool(connId: string, database: string): Promise<void> {
  const key = `${connId}\u0000${database}`;
  const pool = pools.get(key);
  const tasks: Promise<unknown>[] = [];
  if (pool) {
    pools.delete(key);
    tasks.push(pool.end().catch(() => {}));
  }
  for (const [id, s] of sessions) {
    if (s.connId === connId && s.database === database) tasks.push(closeSession(id));
  }
  await Promise.all(tasks);
}

/** Run a query on the pool and return rows as objects. Use for metadata queries. */
export async function queryRows<T = Record<string, any>>(
  connId: string,
  database: string | undefined,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool(connId, database).query(sql, params);
  return res.rows as T[];
}

/** Borrow a pooled client for several statements (e.g. a transaction). Always released. */
export async function withClient<T>(
  connId: string,
  database: string | undefined,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool(connId, database).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Run fn inside BEGIN/COMMIT (ROLLBACK on error). */
export async function withTransaction<T>(
  connId: string,
  database: string | undefined,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(connId, database, async (client) => {
    await client.query('BEGIN');
    try {
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

// ---------------------------------------------------------------- sessions

interface Session {
  connId: string;
  database: string;
  client: pg.Client;
  lastUsed: number;
  busy: Promise<unknown>;
}
const sessions = new Map<string, Session>();

export async function getSession(sessionId: string, connId: string, database: string): Promise<Session> {
  const existing = sessions.get(sessionId);
  if (existing && existing.connId === connId && existing.database === database) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) await closeSession(sessionId);
  const conn = requireConn(connId);
  const client = await connectClient(conn, database);
  client.on('error', () => { sessions.delete(sessionId); });
  const s: Session = { connId, database, client, lastUsed: Date.now(), busy: Promise.resolve() };
  sessions.set(sessionId, s);
  return s;
}

export async function closeSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.client.end().catch(() => {});
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, s] of sessions) if (s.lastUsed < cutoff) void closeSession(id);
}, 60_000).unref();

// ---------------------------------------------------------------- cancellation

/** queryId -> backend pid of the client currently running it. */
const running = new Map<string, { connId: string; database: string; pid: number }>();

export function trackRunning(queryId: string | undefined, connId: string, database: string, client: pg.ClientBase) {
  if (!queryId) return () => {};
  const pid = (client as any).processID as number;
  running.set(queryId, { connId, database, pid });
  return () => running.delete(queryId);
}

export async function cancelQuery(queryId: string): Promise<boolean> {
  const r = running.get(queryId);
  if (!r) return false;
  const rows = await queryRows<{ ok: boolean }>(r.connId, r.database, 'SELECT pg_cancel_backend($1) AS ok', [r.pid]);
  return !!rows[0]?.ok;
}

export async function shutdownAll() {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  await Promise.all([...sessions.keys()].map(closeSession));
}
