import type {
  ColumnInfo, ConnectionConfig, ConnectionTestResult, DbObject, QueryError, QueryRequest,
  QueryResponse, SchemaInfo, ServerInfo,
} from '@shared/types';

/** Error thrown by api helpers. `.info` carries the PostgreSQL error details. */
export class ApiError extends Error {
  constructor(public status: number, public info: QueryError) {
    super(info.message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? { message: res.statusText });
  return data as T;
}

export const http = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
  post: <T>(url: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', url, body ?? {}, signal),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

const enc = encodeURIComponent;
/** Base URL for database-scoped endpoints: /api/c/:connId/db/:db */
export const dbUrl = (connId: string, db: string) => `/api/c/${enc(connId)}/db/${enc(db)}`;

export const api = {
  listConnections: () => http.get<ConnectionConfig[]>('/api/connections'),
  createConnection: (c: ConnectionConfig) => http.post<ConnectionConfig>('/api/connections', c),
  updateConnection: (c: ConnectionConfig) => http.put<ConnectionConfig>(`/api/connections/${enc(c.id)}`, c),
  deleteConnection: (id: string) => http.del<{ ok: boolean }>(`/api/connections/${enc(id)}`),
  testConnection: (c: ConnectionConfig) => http.post<ConnectionTestResult>('/api/connections/test', c),
  connect: (id: string) => http.post<ServerInfo>(`/api/connections/${enc(id)}/connect`),
  disconnect: (id: string) => http.post<{ ok: boolean }>(`/api/connections/${enc(id)}/disconnect`),

  query: (connId: string, db: string, req: QueryRequest, signal?: AbortSignal) =>
    http.post<QueryResponse>(`${dbUrl(connId, db)}/query`, req, signal),
  cancel: (connId: string, queryId: string) => http.post<{ ok: boolean }>(`/api/c/${enc(connId)}/cancel`, { queryId }),
  closeSession: (connId: string, sessionId: string) => http.del(`/api/c/${enc(connId)}/sessions/${enc(sessionId)}`),

  schemas: (connId: string, db: string, system = false) =>
    http.get<SchemaInfo[]>(`${dbUrl(connId, db)}/meta/schemas${system ? '?system=1' : ''}`),
  objects: (connId: string, db: string, schema: string) =>
    http.get<DbObject[]>(`${dbUrl(connId, db)}/meta/schemas/${enc(schema)}/objects`),
  columns: (connId: string, db: string, schema: string, table: string) =>
    http.get<ColumnInfo[]>(`${dbUrl(connId, db)}/meta/tables/${enc(schema)}/${enc(table)}/columns`),
};

/**
 * Convenience: run SQL and throw on error (for features that just need rows).
 * Returns the last result set.
 */
export async function runSql(connId: string, db: string, sql: string, params?: unknown[]) {
  const r = await api.query(connId, db, { sql, params, maxRows: 0, multi: !params });
  if (r.error) throw new ApiError(400, r.error);
  return r.results[r.results.length - 1];
}
