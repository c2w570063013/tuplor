#!/usr/bin/env node
// Stages everything the desktop app needs into desktop/out/:
//
//   out/server/index.mjs   server/dist/index.js bundled with ALL its npm deps (single file, no node_modules)
//   out/web/dist/**        copy of web/dist (the server serves ../web/dist relative to its own file)
//
// Run `npm run build` at the repo root first (scripts/desktop.mjs does this for you).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktopDir, '..');
const out = path.join(desktopDir, 'out');
const serverEntry = path.join(root, 'server/dist/index.js');
const webDist = path.join(root, 'web/dist');

for (const [p, hint] of [
  [serverEntry, 'server/dist/index.js'],
  [path.join(webDist, 'index.html'), 'web/dist/index.html'],
]) {
  if (!fs.existsSync(p)) {
    console.error(`✖ ${hint} is missing — run \`npm run build\` at the repo root first.`);
    process.exit(1);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });

await build({
  entryPoints: [serverEntry],
  outfile: path.join(out, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve bare imports from the workspace's node_modules (hoisted at the repo root).
  nodePaths: [path.join(root, 'node_modules'), path.join(root, 'server/node_modules')],
  // pg optionally requires the native binding; it is never installed.
  external: ['pg-native'],
  // CommonJS deps bundled into ESM still call require() for Node builtins.
  banner: {
    js: [
      "import { createRequire as __pgsCreateRequire } from 'node:module';",
      'const require = __pgsCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
});

fs.cpSync(webDist, path.join(out, 'web/dist'), { recursive: true });

const size = (fs.statSync(path.join(out, 'server/index.mjs')).size / 1024 / 1024).toFixed(1);
console.log(`✔ staged desktop/out (server bundle ${size} MB + web/dist)`);
