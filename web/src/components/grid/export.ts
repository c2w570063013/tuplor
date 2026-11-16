import type { CellValue, GridColumn } from './types';
import { cellToText } from './cell';
import { quoteIdent, quoteLiteral } from '@/lib/format';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

function csvEscape(s: string, sep: string) {
  return /["\n\r]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serialize rows. `table` is used for SQL INSERT output ("schema.table" already quoted or plain name). */
export function serializeRows(columns: GridColumn[], rows: CellValue[][], format: ExportFormat, table = 'my_table'): string {
  switch (format) {
    case 'csv':
    case 'tsv': {
      const sep = format === 'csv' ? ',' : '\t';
      const head = columns.map((c) => csvEscape(c.name, sep)).join(sep);
      return [head, ...rows.map((r) => r.map((v) => csvEscape(cellToText(v), sep)).join(sep))].join('\n');
    }
    case 'json':
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))), null, 2);
    case 'sql': {
      const cols = columns.map((c) => quoteIdent(c.name)).join(', ');
      return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => quoteLiteral(v)).join(', ')});`).join('\n');
    }
    case 'markdown': {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [
        '| ' + columns.map((c) => esc(c.name)).join(' | ') + ' |',
        '| ' + columns.map(() => '---').join(' | ') + ' |',
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
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportRows(columns: GridColumn[], rows: CellValue[][], format: ExportFormat, baseName = 'result', table?: string) {
  downloadText(`${baseName}.${EXT[format]}`, serializeRows(columns, rows, format, table), MIME[format]);
}
