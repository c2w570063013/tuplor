#!/usr/bin/env node
// Desktop (Electron) helper used by the root package.json:
//   npm run desktop:dev     → build web + server, stage them, launch Electron
//   npm run desktop:build   → build web + server, stage them, produce .app/.dmg/.zip (arm64) in desktop/release/
//                             (Developer ID signed + notarized when the signing env vars are set, see docs/RELEASING.md)
//   npm run desktop:assets  → copy dmg/zip + stable alias names + SHA256SUMS.txt into desktop/release/assets/
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
const { productName } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));

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
    run(process.execPath, ['desktop/scripts/license.mjs']);
    run(npm, ['run', 'build']);
    run(npm, ['run', 'dist', '--', ...process.argv.slice(3)], desktop);
    const rel = path.join(desktop, 'release');
    const info = JSON.parse(fs.readFileSync(path.join(rel, 'build-info.json'), 'utf8'));
    console.log(`\n✔ Desktop build ready (${info.mode}):`);
    console.log(`  ${path.join(rel, 'mac-arm64', `${productName}.app`)}`);
    for (const f of info.files) console.log(`  ${path.join(rel, f)}`);
    if (!info.notarized)
      console.log(`\n  Not notarized: if macOS blocks the first launch, use System Settings → Privacy & Security → Open Anyway.`);
    break;
  }
  case 'assets':
    run(process.execPath, ['scripts/release-assets.mjs'], desktop);
    break;
  case 'smoke':
    ensureDesktopDeps();
    run(process.execPath, ['scripts/smoke.mjs', '--app', `release/mac-arm64/${productName}.app`, ...process.argv.slice(3)], desktop);
    break;
  default:
    console.error('usage: node scripts/desktop.mjs <dev|build|assets|smoke>');
    process.exit(1);
}
