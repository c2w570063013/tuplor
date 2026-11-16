import type { RowChange, TableInfo, WriteValue } from '@shared/tableData';
import type { CellValue } from '@shared/types';
import { DEFAULT_VALUE, isDefaultMarker } from '@/components/grid';

/** A staged value: a concrete value or the DEFAULT marker. */
export type StagedValue = CellValue;

export interface InsertedRow {
  key: string;
  /** Explicitly set values by data column index (others use the column default on INSERT). */
  values: Record<number, StagedValue>;
}

/** Staged (uncommitted) edits for the current page. Row indexes refer to the loaded page. */
export interface Staged {
  updates: Record<number, Record<number, StagedValue>>;
  deleted: Record<number, true>;
  inserts: InsertedRow[];
}

export const EMPTY: Staged = { updates: {}, deleted: {}, inserts: [] };

export function countChanges(s: Staged) {
  const rowsUpdated = Object.keys(s.updates).filter((r) => !s.deleted[+r]).length;
  const cellsUpdated = Object.entries(s.updates).filter(([r]) => !s.deleted[+r]).reduce((n, [, m]) => n + Object.keys(m).length, 0);
  const deleted = Object.keys(s.deleted).length;
  const inserted = s.inserts.length;
  return { rowsUpdated, cellsUpdated, deleted, inserted, total: rowsUpdated + deleted + inserted };
}

const same = (a: CellValue, b: CellValue) =>
  a === b || (a !== null && b !== null && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));

/** Set (or revert, when equal to the original) a cell of an existing row. */
export function setCell(s: Staged, row: number, col: number, v: StagedValue, original: CellValue): Staged {
  const rowMap = { ...(s.updates[row] ?? {}) };
  if (!isDefaultMarker(v) && same(v, original)) delete rowMap[col];
  else rowMap[col] = v;
  const updates = { ...s.updates };
  if (Object.keys(rowMap).length) updates[row] = rowMap;
  else delete updates[row];
  return { ...s, updates };
}

export function setInsertCell(s: Staged, idx: number, col: number, v: StagedValue): Staged {
  return { ...s, inserts: s.inserts.map((r, i) => (i === idx ? { ...r, values: { ...r.values, [col]: v } } : r)) };
}

/** Effective display row for an existing page row. */
export function mergedRow(base: CellValue[], upd: Record<number, StagedValue> | undefined): CellValue[] {
  if (!upd) return base;
  const r = base.slice();
  for (const [c, v] of Object.entries(upd)) r[+c] = v;
  return r;
}

/** Display row for a new row: explicit values, else DEFAULT where the column has one, else NULL. */
export function insertedDisplayRow(info: TableInfo, ins: InsertedRow): CellValue[] {
  return info.columns.map((c, i) => {
    if (i in ins.values) return ins.values[i];
    return c.default != null || c.identity || c.isGenerated ? DEFAULT_VALUE : null;
  });
}

const toWrite = (v: StagedValue): WriteValue => (isDefaultMarker(v) ? { $default: true } : v);

/** Build the commit payload. */
export function buildChanges(info: TableInfo, rows: CellValue[][], s: Staged): RowChange[] {
  const keyIdx = info.keyColumns.map((k) => info.columns.findIndex((c) => c.name === k));
  const keyOf = (row: CellValue[]) => Object.fromEntries(info.keyColumns.map((k, i) => [k, row[keyIdx[i]]]));
  const out: RowChange[] = [];
  for (const r of Object.keys(s.deleted)) out.push({ type: 'delete', key: keyOf(rows[+r]) });
  for (const [r, m] of Object.entries(s.updates)) {
    if (s.deleted[+r]) continue;
    const set: Record<string, WriteValue> = {};
    for (const [c, v] of Object.entries(m)) set[info.columns[+c].name] = toWrite(v);
    out.push({ type: 'update', key: keyOf(rows[+r]), set });
  }
  for (const ins of s.inserts) {
    const values: Record<string, WriteValue> = {};
    for (const [c, v] of Object.entries(ins.values)) values[info.columns[+c].name] = toWrite(v);
    out.push({ type: 'insert', values });
  }
  return out;
}
