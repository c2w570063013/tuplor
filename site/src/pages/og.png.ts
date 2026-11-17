import type { APIRoute } from 'astro';
import { ogImage } from '../lib/brand-images';

export const GET: APIRoute = async () =>
  new Response(new Uint8Array(await ogImage()), { headers: { 'Content-Type': 'image/png' } });
