import type { CellValue } from '@shared/types';

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid', 'xid', 'cid']);
const JSONISH = new Set(['json', 'jsonb']);
const TEMPORAL = new Set(['date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval']);

export const isNumericType = (t?: string) => !!t && NUMERIC.has(t);
export const isJsonType = (t?: string) => !!t && JSONISH.has(t);
export const isTemporalType = (t?: string) => !!t && TEMPORAL.has(t);
export const isByteaType = (t?: string) => t === 'bytea';
/** Array types are named with a leading underscore in pg_type ("_int4"). */
export const isArrayType = (t?: string) => !!t && t.startsWith('_');

/** Marker for "column DEFAULT" in staged edits (rendered as a DEFAULT chip). */
export interface DefaultMarker { $default: true }
export const DEFAULT_VALUE: DefaultMarker = Object.freeze({ $default: true as const });
export const isDefaultMarker = (v: unknown): v is DefaultMarker =>
  !!v && typeof v === 'object' && (v as { $default?: unknown }).$default === true;

/** Text used for copy / export. NULL -> '' by default. */
export function cellToText(v: CellValue, nullText = ''): string {
  if (v === null || v === undefined) return nullText;
  if (isDefaultMarker(v)) return 'DEFAULT';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Byte length of a "\x..." bytea hex string. */
export function byteaLength(hex: string): number {
  return hex.startsWith('\\x') ? (hex.length - 2) / 2 : hex.length;
}

const MAGIC: [string, string, string][] = [
  ['89504e47', 'PNG', 'image/png'],
  ['ffd8ff', 'JPEG', 'image/jpeg'],
  ['47494638', 'GIF', 'image/gif'],
  ['52494646', 'WEBP', 'image/webp'],
  ['25504446', 'PDF', 'application/pdf'],
  ['504b0304', 'ZIP', 'application/zip'],
  ['1f8b', 'GZIP', 'application/gzip'],
];

/** Detect common file signatures in a bytea hex value. */
export function byteaKind(hex: string): { label: string; mime: string } | null {
  const h = hex.slice(2, 18).toLowerCase();
  for (const [sig, label, mime] of MAGIC) if (h.startsWith(sig)) return { label, mime };
  return null;
}

export function formatByteSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Render a cell value for the grid (single line). */
export function renderCell(v: CellValue, typeName?: string) {
  if (v === null || v === undefined) return <span className="text-null italic select-none">NULL</span>;
  if (isDefaultMarker(v)) {
    return <span className="rounded bg-active px-1 py-px text-[10px] font-medium tracking-wide text-muted select-none">DEFAULT</span>;
  }
  if (typeof v === 'boolean') {
    return (
      <span className={v ? 'text-success' : 'text-danger'}>
        <span className="mr-1 inline-block w-2.5 text-center">{v ? '✓' : '✕'}</span>
        {v ? 'true' : 'false'}
      </span>
    );
  }
  if (typeof v === 'number' || isNumericType(typeName)) return <span className="text-syntax-number tabular-nums">{String(v)}</span>;
  if (isJsonType(typeName) || typeof v === 'object') {
    const s = typeof v === 'object' ? JSON.stringify(v) : v;
    return <span className="font-mono text-[0.95em] text-syntax-string">{s.length > 300 ? s.slice(0, 300) + '…' : s}</span>;
  }
  const s = String(v);
  if (isByteaType(typeName) && s.startsWith('\\x')) {
    const len = byteaLength(s);
    const kind = byteaKind(s);
    if (kind || len > 32) {
      return (
        <span className="font-mono text-[0.95em] text-muted">
          <span className="mr-1.5 rounded bg-active px-1 py-px font-sans text-[10px] font-medium text-fg">{kind?.label ?? 'binary'} · {formatByteSize(len)}</span>
          {s.slice(0, 34)}…
        </span>
      );
    }
    return <span className="font-mono text-[0.95em] text-muted">{s}</span>;
  }
  if (s === '') return <span className="text-[10px] tracking-wide text-subtle/70 select-none">EMPTY</span>;
  if (isArrayType(typeName)) return <span className="text-info">{s.length > 300 ? s.slice(0, 300) + '…' : s}</span>;
  const oneLine = s.length > 500 ? s.slice(0, 500) + '…' : s;
  return oneLine.includes('\n') ? oneLine.replace(/\r?\n/g, ' ↵ ') : oneLine;
}

/**
 * Parse a one-dimensional PostgreSQL array literal ("{a,\"b c\",NULL}") into elements.
 * Returns null for multi-dimensional / unparsable input.
 */
export function parsePgArray(s: string): (string | null)[] | null {
  let t = s.trim();
  if (t.startsWith('[')) {
    const eq = t.indexOf('=');
    if (eq < 0) return null;
    t = t.slice(eq + 1);
  }
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const body = t.slice(1, -1);
  if (body === '') return [];
  if (body.trimStart().startsWith('{')) return null;
  const out: (string | null)[] = [];
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let v = '';
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i++;
        v += body[i++];
      }
      i++; // closing quote
      out.push(v);
    } else {
      let j = i;
      while (j < body.length && body[j] !== ',') j++;
      const raw = body.slice(i, j).trim();
      out.push(raw.toUpperCase() === 'NULL' ? null : raw);
      i = j;
    }
    if (body[i] === ',') i++;
    else break;
  }
  return out;
}
