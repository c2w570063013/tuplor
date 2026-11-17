#!/usr/bin/env node
// Collects the GitHub Release assets into desktop/release/assets/ (after `npm run desktop:build`):
//
//   <Slug>-<version>-mac-arm64.dmg / .zip   versioned files
//   <Slug>-mac-arm64.dmg / .zip             stable aliases → …/releases/latest/download/<alias>
//   SHA256SUMS.txt                          sha256 of all of the above (shasum -a 256 -c format)
//
// Prints the asset paths, one per line, on stdout (progress goes to stderr).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { artifactNames, desktopDir } from './product.mjs';

const releaseDir = path.join(desktopDir, 'release');
const outDir = path.join(releaseDir, 'assets');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });

const names = [];
for (const ext of ['dmg', 'zip']) {
  const { versioned, alias } = artifactNames(ext);
  const src = path.join(releaseDir, versioned);
  if (!fs.existsSync(src)) {
    console.error(`✖ ${path.relative(process.cwd(), src)} not found — run \`npm run desktop:build\` first.`);
    process.exit(1);
  }
  // APFS clone when possible (instant, no extra disk space), plain copy otherwise.
  fs.copyFileSync(src, path.join(outDir, versioned), fs.constants.COPYFILE_FICLONE);
  fs.copyFileSync(src, path.join(outDir, alias), fs.constants.COPYFILE_FICLONE);
  names.push(versioned, alias);
}

const lines = [];
for (const n of names) lines.push(`${await sha256(path.join(outDir, n))}  ${n}`);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
names.push('SHA256SUMS.txt');

console.error(`✔ release assets in ${path.relative(process.cwd(), outDir) || outDir}:`);
for (const n of names) console.log(path.join(outDir, n));
