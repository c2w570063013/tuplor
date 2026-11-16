#!/usr/bin/env node
// One-command PG Studio for browser users:  npm run app
//
// Builds web + server if the build is missing or older than the sources, starts the server
// (PORT env or 5555; falls back to a free port), waits until it is healthy and opens the
// default browser. If PG Studio is already running on that port it just opens the browser.
// Ctrl+C stops the server.
//
//   npm run app                 # build if needed, start, open browser
//   npm run app -- --rebuild    # force a rebuild
//   npm run app -- --no-open    # don't open the browser
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const argv = new Set(process.argv.slice(2));
const HOST = process.env.HOST || '127.0.0.1';
const wantedPort = Number(process.env.PORT || 5555);

const serverOut = path.join(root, 'server/dist/index.js');
const webOut = path.join(root, 'web/dist/index.html');

/** Newest mtime of any file under the given paths (skips node_modules/dist). */
function newest(paths) {
  let max = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) if (f !== 'node_modules' && f !== 'dist') walk(path.join(p, f));
    } else max = Math.max(max, st.mtimeMs);
  };
  paths.forEach((p) => walk(path.join(root, p)));
  return max;
}

function needsBuild() {
  if (argv.has('--rebuild') || !fs.existsSync(serverOut) || !fs.existsSync(webOut)) return true;
  const built = Math.min(fs.statSync(serverOut).mtimeMs, fs.statSync(webOut).mtimeMs);
  const src = newest(['server/src', 'web/src', 'web/public', 'web/index.html', 'shared', 'server/package.json', 'web/package.json']);
  return src > built;
}

const isFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: HOST, exclusive: true }, () => s.close(() => resolve(true)));
  });
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen({ port: 0, host: HOST }, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function healthy(url) {
  try {
    const r = await fetch(url + 'api/health', { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    return r.ok && j?.ok === true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (argv.has('--no-open')) return;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.log('→ installing dependencies…');
  if (spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
}
if (needsBuild()) {
  console.log('→ building PG Studio…');
  if (spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
}

let port = wantedPort;
if (!(await isFree(port))) {
  const existing = `http://${displayHost}:${port}/`;
  if (await healthy(existing)) {
    console.log(`✔ PG Studio is already running at ${existing}`);
    openBrowser(existing);
    process.exit(0);
  }
  port = await freePort();
  console.log(`• port ${wantedPort} is busy, using ${port}`);
}

const url = `http://${displayHost}:${port}/`;
const server = spawn(process.execPath, [serverOut], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), HOST, NODE_ENV: 'production' },
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

const deadline = Date.now() + 30_000;
while (!(await healthy(url))) {
  if (Date.now() > deadline) {
    console.error('✖ server did not become ready within 30s');
    server.kill('SIGTERM');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 150));
}
console.log(`  Opening ${url}  (Ctrl+C to stop)\n`);
openBrowser(url);
