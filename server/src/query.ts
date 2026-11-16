import Cursor from 'pg-cursor';
import type pg from 'pg';
import type { CellValue, FieldInfo, QueryNotice, QueryRequest, QueryResponse, ResultSet, TxStatus } from '../../shared/types';
import { getPool, getSession, trackRunning } from './db';
import { toQueryError } from './lib/errors';
import { splitStatements } from './lib/sql';

/** Type OID -> name cache per connection key (OIDs are per-cluster, stable). */
const typeNameCache = new Map<string, Map<number, string>>();

async function typeNames(client: pg.ClientBase, cacheKey: string, oids: number[]): Promise<Map<number, string>> {
  let cache = typeNameCache.get(cacheKey);
  if (!cache) typeNameCache.set(cacheKey, (cache = new Map()));
  const missing = [...new Set(oids)].filter((o) => !cache!.has(o));
  if (missing.length) {
    const r = await client.query('SELECT oid::int, typname FROM pg_type WHERE oid = ANY($1::oid[])', [missing]);
    for (const row of r.rows) cache.set(row.oid, row.typname);
  }
  return cache;
}

const MAX_CAP = 1_000_000;

function readCursor(cursor: Cursor, n: number): Promise<{ rows: any[]; result: any }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err: Error | undefined, rows: any[], result: any) => {
      if (err) reject(err);
      else resolve({ rows, result });
    });
  });
}

function closeCursor(cursor: Cursor): Promise<void> {
  return new Promise((resolve) => cursor.close(() => resolve()));
}

function normalizeCell(v: unknown): CellValue {
  if (v === undefined) return null;
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (typeof v === 'bigint') return v.toString();
  return v as CellValue;
}

async function runOne(client: pg.ClientBase, text: string, maxRows: number, params?: unknown[]): Promise<Omit<ResultSet, 'durationMs'>> {
  const cursor = client.query(new Cursor(text, params as any[] | undefined, { rowMode: 'array' } as any));
  try {
    const limit = maxRows > 0 ? Math.min(maxRows, MAX_CAP) : MAX_CAP;
    const { rows, result } = await readCursor(cursor, limit + 1);
    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    const fields: FieldInfo[] = (result?.fields ?? []).map((f: any) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      typeName: '',
      tableID: f.tableID || undefined,
      columnID: f.columnID || undefined,
    }));
    return {
      command: result?.command || (fields.length ? 'SELECT' : ''),
      fields,
      rows: rows.map((r: unknown[]) => r.map(normalizeCell)),
      rowCount: truncated ? null : (result?.command === 'SELECT' || !result?.command ? rows.length : result?.rowCount ?? null),
      truncated,
    };
  } finally {
    await closeCursor(cursor);
  }
}

/**
 * Execute SQL. Splits into statements (unless multi=false or params are given), runs them
 * sequentially, stops at the first error. Errors are returned inside the response (HTTP 200)
 * together with any results that completed before the failure.
 */
export async function executeQuery(connId: string, database: string, req: QueryRequest): Promise<QueryResponse> {
  const t0 = performance.now();
  const notices: QueryNotice[] = [];
  const results: ResultSet[] = [];
  const maxRows = req.maxRows ?? 1000;

  const useSplit = req.multi !== false && !(req.params && req.params.length);
  const statements = useSplit ? splitStatements(req.sql) : [{ text: req.sql, start: 0 }];

  let client: pg.ClientBase;
  let release: () => void = () => {};
  let session: Awaited<ReturnType<typeof getSession>> | undefined;
  try {
    if (req.sessionId) {
      session = await getSession(req.sessionId, connId, database);
      client = session.client;
    } else {
      const pc = await getPool(connId, database).connect();
      client = pc;
      release = () => pc.release();
    }
  } catch (e) {
    return { results, notices, error: toQueryError(e), totalDurationMs: performance.now() - t0 };
  }

  const onNotice = (n: any) => notices.push({ severity: n.severity || 'NOTICE', message: n.message });
  client.on('notice', onNotice);
  const untrack = trackRunning(req.queryId, connId, database, client);
  let error: QueryResponse['error'];
  let rolledBack = false;

  try {
    if (req.rollback) await client.query('BEGIN');
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i];
      const s0 = performance.now();
      try {
        const r = await runOne(client, st.text, maxRows, req.params);
        results.push({ ...r, durationMs: performance.now() - s0, statement: statements.length > 1 ? st.text : undefined });
      } catch (e) {
        error = toQueryError(e);
        error.statementIndex = i;
        if (error.position) error.position += st.start;
        break;
      }
    }
    if (req.rollback) { await client.query('ROLLBACK'); rolledBack = true; }
    // resolve type names
    const oids = results.flatMap((r) => r.fields.map((f) => f.dataTypeID));
    if (oids.length) {
      try {
        // a failed transaction can't run queries; fall back to the pool for the lookup
        const tx = (client as any).getTransactionStatus?.();
        const lookupClient = tx === 'E' ? await getPool(connId, database).connect() : null;
        try {
          const names = await typeNames(lookupClient ?? client, connId, oids);
          for (const r of results) for (const f of r.fields) f.typeName = names.get(f.dataTypeID) ?? String(f.dataTypeID);
        } finally {
          lookupClient?.release();
        }
      } catch { /* type names are cosmetic */ }
    }
  } catch (e) {
    error = error ?? toQueryError(e);
  } finally {
    if (req.rollback && !rolledBack) await client.query('ROLLBACK').catch(() => {});
    client.off('notice', onNotice);
    untrack();
    release();
  }

  let txStatus: TxStatus | undefined;
  if (session) {
    const s = (client as any).getTransactionStatus?.();
    txStatus = s === 'T' ? 'transaction' : s === 'E' ? 'error' : 'idle';
  }
  return { results, notices, error, totalDurationMs: performance.now() - t0, txStatus };
}
