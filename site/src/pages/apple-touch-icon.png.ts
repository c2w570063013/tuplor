import type { APIRoute } from 'astro';
import { iconPng } from '../lib/brand-images';

// iOS applies its own rounded mask, so give the mark a little breathing room on a dark tile.
export const GET: APIRoute = async () =>
  new Response(new Uint8Array(await iconPng(180, 18)), { headers: { 'Content-Type': 'image/png' } });
