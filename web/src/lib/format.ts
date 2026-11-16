export function formatBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}

export function qualified(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column ' +
  'concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp ' +
  'current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike ' +
  'in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null ' +
  'offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric ' +
  'system_user table tablesample then to trailing true union unique user using variadic verbose when where window with').split(' '));

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
