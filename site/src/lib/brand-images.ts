// Build-time generated brand images (OG card, PNG favicons) so that a rename in
// src/config.ts automatically produces matching images — no design tool needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SITE } from '../config';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const FONT = `Inter, 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif`;

export const MARK = (size: number, x = 0, y = 0) => `
  <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 64 64">
    <defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#6366f1"/></linearGradient><clipPath id="mc"><rect x="13" y="13" width="38" height="38" rx="7"/></clipPath></defs>
    <rect width="64" height="64" rx="15" fill="url(#m)"/>
    <g clip-path="url(#mc)" fill="#fff"><rect x="13" y="13" width="38" height="10"/><rect x="27.5" y="23" width="9" height="28"/></g>
    <path d="M13 37h14.5M36.5 37H51" stroke="#fff" stroke-opacity=".6" stroke-width="2.5"/>
    <rect x="13" y="13" width="38" height="38" rx="7" fill="none" stroke="#fff" stroke-width="3"/>
  </svg>`;

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function ogImage(): Promise<Buffer> {
  const W = 1200, H = 630;
  const shotPath = path.resolve('src/assets/screens/editor-dark.png');
  const shotW = 860, shotH = Math.round((shotW * 1800) / 2880);
  const radius = 14;
  // The screenshot bleeds off the right/bottom edge: crop the visible part, round the top-left corner.
  const sx = 640, sy = 150, vw = W - sx, vh = H - sy;
  const shot = await sharp(await fs.readFile(shotPath))
    .resize(shotW, shotH)
    .extract({ left: 0, top: 0, width: vw, height: vh })
    .composite([{ input: Buffer.from(`<svg width="${vw}" height="${vh}"><rect width="${vw + 40}" height="${vh + 40}" rx="${radius}" fill="#fff"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();

  const tag = wrap(SITE.tagline.en, 30);
  // Pills: width estimated from text length (≈0.6em per char covers Helvetica and DejaVu Sans).
  const chipFs = 16;
  let cx = 72;
  const chips = [
    { text: `Free & open source · ${SITE.license}`, fill: '#1c2033', stroke: '#353c5c', color: '#c7cdf5' },
    { text: 'macOS · Apple Silicon', fill: '#4f46e5', stroke: '#4f46e5', color: '#ffffff' },
  ].map((c) => {
    const w = Math.round(c.text.length * chipFs * 0.58 + 32);
    const out = `<rect x="${cx}" y="502" width="${w}" height="44" rx="22" fill="${c.fill}" stroke="${c.stroke}"/>` +
      `<text x="${cx + w / 2}" y="530" text-anchor="middle" font-family="${FONT}" font-size="${chipFs}" font-weight="600" fill="${c.color}">${esc(c.text)}</text>`;
    cx += w + 12;
    return out;
  }).join('');
  const nameSize = SITE.name.length > 12 ? 60 : 76;
  const bg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g1" cx="0.15" cy="0.1" r="0.9"><stop offset="0" stop-color="#4f46e5" stop-opacity="0.55"/><stop offset="1" stop-color="#0b0d12" stop-opacity="0"/></radialGradient>
      <radialGradient id="g2" cx="0.95" cy="0.95" r="0.7"><stop offset="0" stop-color="#22d3ee" stop-opacity="0.22"/><stop offset="1" stop-color="#0b0d12" stop-opacity="0"/></radialGradient>
      <filter id="sh" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.55"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="#0b0d12"/>
    <rect width="${W}" height="${H}" fill="url(#g1)"/>
    <rect width="${W}" height="${H}" fill="url(#g2)"/>
    ${MARK(76, 72, 76)}
    <text x="72" y="${232 + (76 - nameSize) / 2}" font-family="${FONT}" font-size="${nameSize}" font-weight="800" fill="#f5f7ff" letter-spacing="-1.5">${esc(SITE.name)}</text>
    ${tag.map((l, i) => `<text x="72" y="${300 + i * 40}" font-family="${FONT}" font-size="30" font-weight="500" fill="#aab2d5">${esc(l)}</text>`).join('')}
    ${chips}
    <rect x="${sx - 2}" y="${sy - 2}" width="${vw + 40}" height="${vh + 40}" rx="${radius + 2}" fill="#2a2f45" filter="url(#sh)"/>
  </svg>`;

  return sharp(Buffer.from(bg))
    .composite([{ input: shot, left: sx, top: sy }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function iconPng(size: number, padding = 0): Promise<Buffer> {
  const inner = size - padding * 2;
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${padding ? `<rect width="${size}" height="${size}" fill="#0b0d12"/>` : ''}${MARK(inner, padding, padding)}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
