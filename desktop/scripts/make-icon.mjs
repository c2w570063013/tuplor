#!/usr/bin/env node
// Generates desktop/build/icon.icns (+ icon.png) from web/public/logo.svg.
// The logo is placed on the macOS Big Sur icon grid: an 824×824 tile centered on a
// 1024×1024 canvas with a soft drop shadow. Requires macOS `iconutil`.
//   node scripts/make-icon.mjs
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = fs.readFileSync(path.resolve(desktopDir, '../web/public/logo.svg'), 'utf8');
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// Logo is 64×64 with rx=14; scale to 824 (factor 12.875) and use Apple's ~185px corner radius.
const scale = 824 / 64;
const tile = inner.replace(/<rect width="64" height="64" rx="14"/, '<rect width="64" height="64" rx="14.4"');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g filter="url(#shadow)"><g transform="translate(100 100) scale(${scale})">${tile}</g></g>
</svg>`;

const buildDir = path.join(desktopDir, 'build');
fs.mkdirSync(buildDir, { recursive: true });
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

fs.writeFileSync(path.join(buildDir, 'icon.png'), render(1024));

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstudio-')) + '/icon.iconset';
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), render(s));
  fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), render(s * 2));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
console.log('✔ wrote build/icon.icns and build/icon.png');
