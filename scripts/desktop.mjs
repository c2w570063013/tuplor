#!/usr/bin/env node
// Desktop (Electron) helper used by the root package.json:
//   npm run desktop:dev     → build web + server, stage them, launch Electron
//   npm run desktop:build   → build web + server, stage them, produce .app/.dmg (arm64) in desktop/release/
//   npm run desktop:smoke   → end-to-end smoke test of the packaged app (after desktop:build)
//
// desktop/ is a standalone npm package (not a workspace) so Electron and electron-builder
// never leak into the server/web dependency trees. Its deps are installed on first use.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mode = process.argv[2];

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function ensureDesktopDeps() {
  if (!fs.existsSync(path.join(desktop, 'node_modules/electron-builder'))) {
    console.log('→ installing desktop dependencies (first run)…');
    run(npm, ['install', '--no-audit', '--no-fund'], desktop);
  }
  // The Electron binary is fetched by its install script; npm may skip install scripts.
  if (!fs.existsSync(path.join(desktop, 'node_modules/electron/path.txt'))) {
    console.log('→ downloading the Electron runtime…');
    run(process.execPath, ['node_modules/electron/install.js'], desktop);
  }
}

switch (mode) {
  case 'dev':
    ensureDesktopDeps();
    run(npm, ['run', 'build']);
    run(npm, ['run', 'dev'], desktop);
    break;
  case 'build': {
    ensureDesktopDeps();
    run(npm, ['run', 'build']);
    run(npm, ['run', 'dist'], desktop);
    const rel = path.join(desktop, 'release');
    const out = fs.readdirSync(rel).filter((f) => /\.(dmg|zip)$/.test(f));
    console.log('\n✔ Desktop build ready:');
    console.log(`  ${path.join(rel, 'mac-arm64', 'PG Studio.app')}`);
    for (const f of out) console.log(`  ${path.join(rel, f)}`);
    console.log('\n  Unsigned app: on first launch right-click "PG Studio" → Open (or System Settings → Privacy & Security → Open Anyway).');
    break;
  }
  case 'smoke':
    ensureDesktopDeps();
    run(process.execPath, ['scripts/smoke.mjs', '--app', 'release/mac-arm64/PG Studio.app', ...process.argv.slice(3)], desktop);
    break;
  default:
    console.error('usage: node scripts/desktop.mjs <dev|build|smoke>');
    process.exit(1);
}
