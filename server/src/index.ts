import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes';
import { HttpError, toQueryError } from './lib/errors';
import { shutdownAll } from './db';

const PORT = Number(process.env.PORT || 5555);
const HOST = process.env.HOST || '127.0.0.1';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, bodyLimit: 200 * 1024 * 1024 });

app.setErrorHandler((err: any, _req, reply) => {
  const status = err instanceof HttpError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : err.code ? 400 : 500;
  reply.status(status).send({ error: toQueryError(err) });
});

await registerRoutes(app);

app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));

// Serve the built web app in production.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [process.env.TUPLOR_WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist')]
  .filter((p): p is string => !!p)
  .find((p) => fs.existsSync(p));
if (webDist) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { message: 'Not found' } });
    return reply.sendFile('index.html');
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await shutdownAll();
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
console.log(`\n  Tuplor server running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
