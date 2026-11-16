#!/usr/bin/env node
// End-to-end smoke test of the desktop app over the Chrome DevTools Protocol.
//
//   node scripts/smoke.mjs                       # dev: node_modules/electron against desktop/out
//   node scripts/smoke.mjs --app "release/mac-arm64/PG Studio.app"
//   node scripts/smoke.mjs --app … --screenshot /tmp/pgstudio.png
//
// Launches the app with --remote-debugging-port, waits for the UI, checks the preload bridge
// and the title-bar CSS, connects the first saved connection whose name contains "demo"
// (or the first one), runs a query through the app's own server, optionally saves a
// screenshot, quits the app and verifies the server child went away.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const appArg = arg('--app');
const shot = arg('--screenshot');
const port = 9339;

let exe, args;
if (appArg) {
  const appPath = path.resolve(appArg);
  exe = path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app'));
  args = [];
} else {
  exe = (await import(path.join(desktopDir, 'node_modules/electron/index.js'))).default;
  args = [desktopDir];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error('✖ ' + msg);
  child?.kill('SIGTERM');
  process.exit(1);
};

console.log(`→ launching ${exe}`);
const child = spawn(exe, [...args, `--remote-debugging-port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));

// Find the page target.
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));
  } catch {
    /* not up yet */
  }
}
if (!target) fail('no app page appeared within 30s');
const appUrl = new URL(target.url).origin;
console.log(`✔ window loaded ${target.url}`);

// Minimal CDP client.
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

// Wait for React to render the shell.
for (let i = 0; i < 100; i++) {
  if (await evaluate(`document.querySelector('#root')?.children.length > 0`)) break;
  await sleep(100);
}

const bridge = await evaluate(`JSON.stringify({ d: window.pgstudioDesktop && { isDesktop: window.pgstudioDesktop.isDesktop, platform: window.pgstudioDesktop.platform, onCommand: typeof window.pgstudioDesktop.onCommand }, cls: document.documentElement.className })`);
const b = JSON.parse(bridge);
if (!b.d?.isDesktop || b.d.onCommand !== 'function') fail('window.pgstudioDesktop bridge missing: ' + bridge);
console.log(`✔ preload bridge: platform=${b.d.platform}, <html class="${b.cls}">`);

if (b.d.platform === 'darwin') {
  const tb = JSON.parse(
    await evaluate(`(() => {
      const el = document.querySelector('[data-titlebar]') || document.querySelector('#root > div.h-full.flex-col > div:first-child');
      if (!el) return JSON.stringify(null);
      const cs = getComputedStyle(el);
      return JSON.stringify({ region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'), pad: cs.paddingLeft });
    })()`),
  );
  if (!tb) fail('top bar element not found for title-bar CSS');
  console.log(`✔ title bar: app-region=${tb.region}, padding-left=${tb.pad}`);
}

const result = JSON.parse(
  await evaluate(`(async () => {
    const j = async (url, body) => {
      const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const t = await r.json();
      if (!r.ok) throw new Error(url + ': ' + JSON.stringify(t));
      return t;
    };
    const list = await j('/api/connections');
    const c = list.find((c) => /demo/i.test(c.name)) || list[0];
    if (!c) return JSON.stringify({ skipped: 'no saved connections' });
    const info = await j('/api/connections/' + c.id + '/connect', {});
    const db = c.database || 'postgres';
    const q = await j('/api/c/' + c.id + '/db/' + encodeURIComponent(db) + '/query', { sql: "select version() as v, current_database() as db, (select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')) as tables" });
    return JSON.stringify({ name: c.name, db, info: { version: info.version || info.serverVersion }, rs: q.results?.[0] ?? q[0] ?? q });
  })()`),
);
if (result.skipped) console.log(`• database check skipped (${result.skipped})`);
else {
  const row = JSON.stringify(result.rs?.rows?.[0] ?? result.rs).slice(0, 220);
  console.log(`✔ connected "${result.name}" → ${result.db}: ${row}`);
}

if (shot) {
  // Open the demo database in the UI explorer, if possible, so the screenshot shows real data.
  await sleep(1500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
  console.log(`✔ screenshot → ${shot}`);
}

ws.close();
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
await sleep(500);
const alive = await fetch(appUrl + '/api/health').then(() => true, () => false);
if (alive) fail(`server at ${appUrl} still running after quit`);
console.log('✔ quit cleanly; server child stopped');
