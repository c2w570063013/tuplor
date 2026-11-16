import type { CellValue, GridColumn } from './types';
import { cellToText, isDefaultMarker, isJsonType, isNumericType } from './cell';
import { quoteIdent, quoteLiteral } from '@/lib/format';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: 'csv', label: 'CSV', ext: 'csv' },
  { value: 'tsv', label: 'TSV', ext: 'tsv' },
  { value: 'json', label: 'JSON', ext: 'json' },
  { value: 'sql', label: 'SQL INSERT', ext: 'sql' },
  { value: 'markdown', label: 'Markdown', ext: 'md' },
];

function csvEscape(s: string, sep: string) {
  return /["\n\r]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** JSON-friendly value: parse json/jsonb text, turn safe numeric strings into numbers. */
export function jsonValue(v: CellValue, typeName?: string): unknown {
  if (v === null || v === undefined) return null;
  if (isDefaultMarker(v)) return null;
  if (typeof v !== 'string') return v;
  if (isJsonType(typeName)) {
    try { return JSON.parse(v); } catch { return v; }
  }
  if (isNumericType(typeName)) {
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v) return n;
  }
  return v;
}

function sqlLiteral(v: CellValue, typeName?: string): string {
  if (isDefaultMarker(v)) return 'DEFAULT';
  if (typeof v === 'string' && isNumericType(typeName) && /^-?\d+(\.\d+)?$/.test(v)) return v;
  if (typeof v === 'string' && v.includes('\\')) return "E'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  return quoteLiteral(v);
}

export interface SerializeOptions {
  /** Target table for SQL INSERT output (already quoted, e.g. shop.orders). */
  table?: string;
  /** Include a header row for CSV / TSV (default true). */
  header?: boolean;
}

/** Serialize rows. `table` is used for SQL INSERT output ("schema.table" already quoted or plain name). */
export function serializeRows(
  columns: GridColumn[], rows: CellValue[][], format: ExportFormat, tableOrOpts: string | SerializeOptions = 'my_table',
): string {
  const opts: SerializeOptions = typeof tableOrOpts === 'string' ? { table: tableOrOpts } : tableOrOpts;
  const table = opts.table ?? 'my_table';
  switch (format) {
    case 'csv':
    case 'tsv': {
      const sep = format === 'csv' ? ',' : '\t';
      const body = rows.map((r) => r.map((v) => csvEscape(cellToText(v), sep)).join(sep));
      if (opts.header === false) return body.join('\n');
      return [columns.map((c) => csvEscape(c.name, sep)).join(sep), ...body].join('\n');
    }
    case 'json':
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(r[i] ?? null, c.typeName)]))), null, 2);
    case 'sql': {
      const cols = columns.map((c) => quoteIdent(c.name)).join(', ');
      return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlLiteral(v, columns[i]?.typeName)).join(', ')});`).join('\n');
    }
    case 'markdown': {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      return [
        '| ' + columns.map((c) => esc(c.name)).join(' | ') + ' |',
        '|' + columns.map((c) => (isNumericType(c.typeName) ? ' ---: |' : ' --- |')).join(''),
        ...rows.map((r) => '| ' + r.map((v) => esc(cellToText(v, 'NULL'))).join(' | ') + ' |'),
      ].join('\n');
    }
  }
}

const MIME: Record<ExportFormat, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', sql: 'application/sql', markdown: 'text/markdown' };
const EXT: Record<ExportFormat, string> = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql', markdown: 'md' };

/** Trigger a browser download of a text file. */
export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Trigger a download of a URL (e.g. a streaming server export endpoint). */
export function downloadUrl(url: string, filename = '') {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function exportRows(columns: GridColumn[], rows: CellValue[][], format: ExportFormat, baseName = 'result', table?: string) {
  downloadText(`${baseName}.${EXT[format]}`, serializeRows(columns, rows, format, table), MIME[format]);
}

/** Copy text to the clipboard (with a fallback for non-secure contexts). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
