import type { FastifyInstance } from 'fastify';
import type { QueryRequest } from '../../../shared/types';
import { cancelQuery, closeSession } from '../db';
import { executeQuery } from '../query';

export default async function queryRoutes(app: FastifyInstance) {
  app.post<{ Params: { connId: string; db: string }; Body: QueryRequest }>(
    '/api/c/:connId/db/:db/query',
    async (req) => executeQuery(req.params.connId, req.params.db, req.body),
  );

  app.post<{ Params: { connId: string }; Body: { queryId: string } }>('/api/c/:connId/cancel', async (req) => {
    return { ok: await cancelQuery(req.body.queryId) };
  });

  app.delete<{ Params: { connId: string; sessionId: string } }>('/api/c/:connId/sessions/:sessionId', async (req) => {
    await closeSession(req.params.sessionId);
    return { ok: true };
  });
}
