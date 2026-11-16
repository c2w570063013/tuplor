import type { CellValue } from '@shared/types';

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);
const JSONISH = new Set(['json', 'jsonb']);

export const isNumericType = (t?: string) => !!t && NUMERIC.has(t);
export const isJsonType = (t?: string) => !!t && JSONISH.has(t);

/** Text used for copy / export. NULL -> '' by default. */
export function cellToText(v: CellValue, nullText = ''): string {
  if (v === null || v === undefined) return nullText;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Render a cell value for the grid (single line). */
export function renderCell(v: CellValue, typeName?: string) {
  if (v === null || v === undefined) return <span className="text-null italic select-none">NULL</span>;
  if (typeof v === 'boolean') return <span className={v ? 'text-success' : 'text-danger'}>{v ? 'true' : 'false'}</span>;
  if (typeof v === 'number' || isNumericType(typeName)) return <span className="text-syntax-number tabular-nums">{String(v)}</span>;
  if (isJsonType(typeName) || typeof v === 'object') {
    const s = typeof v === 'object' ? JSON.stringify(v) : v;
    return <span className="font-mono text-syntax-string">{s.length > 300 ? s.slice(0, 300) + '…' : s}</span>;
  }
  const s = String(v);
  if (s === '') return <span className="text-null select-none">∅ empty</span>;
  const oneLine = s.length > 500 ? s.slice(0, 500) + '…' : s;
  return oneLine.replace(/\n/g, '↵ ');
}
