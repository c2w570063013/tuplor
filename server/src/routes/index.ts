import type { FastifyInstance } from 'fastify';
import connections from './connections';
import query from './query';
import meta from './meta';
import tableData from './tableData';
import schema from './schema';
import completion from './completion';
import monitor from './monitor';
import roles from './roles';
import erd from './erd';
import backup from './backup';

export async function registerRoutes(app: FastifyInstance) {
  for (const r of [connections, query, meta, tableData, schema, completion, monitor, roles, erd, backup]) {
    await app.register(r);
  }
}
