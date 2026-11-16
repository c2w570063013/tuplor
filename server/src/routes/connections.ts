import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ConnectionConfig, ConnectionTestResult, DatabaseInfo, ServerInfo } from '../../../shared/types';
import { clientConfig, closeConnection, queryRows } from '../db';
import { toQueryError, HttpError } from '../lib/errors';
import { deleteConnection, getConnectionWithSecret, listConnections, saveConnection } from '../store';

export default async function connectionsRoutes(app: FastifyInstance) {
  app.get('/api/connections', async () => listConnections());

  app.post<{ Body: ConnectionConfig }>('/api/connections', async (req) => {
    return saveConnection({ ...req.body, id: '' });
  });

  app.put<{ Params: { id: string }; Body: ConnectionConfig }>('/api/connections/:id', async (req) => {
    if (!getConnectionWithSecret(req.params.id)) throw new HttpError(404, 'Connection not found');
    await closeConnection(req.params.id);
    return saveConnection({ ...req.body, id: req.params.id });
  });

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    await closeConnection(req.params.id);
    return { ok: deleteConnection(req.params.id) };
  });

  /** Test a config. If `id` is given and password is undefined, the stored password is used. */
  app.post<{ Body: ConnectionConfig }>('/api/connections/test', async (req): Promise<ConnectionTestResult> => {
    let cfg = req.body;
    if (cfg.id && cfg.password === undefined) {
      const stored = getConnectionWithSecret(cfg.id);
      cfg = { ...cfg, password: stored?.password };
    }
    const client = new pg.Client(clientConfig(cfg));
    const t0 = performance.now();
    try {
      await client.connect();
      const r = await client.query('SHOW server_version');
      return { ok: true, serverVersion: r.rows[0].server_version, latencyMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: toQueryError(e).message };
    } finally {
      client.end().catch(() => {});
    }
  });

  /** Connect (warm the pool) and return server info + database list. */
  app.post<{ Params: { id: string } }>('/api/connections/:id/connect', async (req): Promise<ServerInfo> => {
    const id = req.params.id;
    const [info] = await queryRows(id, undefined, `
      SELECT version() AS version,
             current_setting('server_version_num')::int AS "versionNum",
             current_user AS "currentUser",
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS "isSuperuser"`);
    const databases = await queryRows<DatabaseInfo>(id, undefined, `
      SELECT d.datname AS name,
             pg_get_userbyid(d.datdba) AS owner,
             pg_encoding_to_char(d.encoding) AS encoding,
             CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS "sizeBytes",
             d.datistemplate AS "isTemplate",
             d.datallowconn AS "allowConn"
        FROM pg_database d
       ORDER BY d.datistemplate, d.datname`);
    for (const d of databases) d.sizeBytes = d.sizeBytes == null ? null : Number(d.sizeBytes);
    return { ...(info as any), databases };
  });

  app.post<{ Params: { id: string } }>('/api/connections/:id/disconnect', async (req) => {
    await closeConnection(req.params.id);
    return { ok: true };
  });
}
