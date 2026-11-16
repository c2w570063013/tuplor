import type { CellValue } from '@shared/types';

export interface GridColumn {
  name: string;
  /** PostgreSQL type name (int4, text, jsonb, timestamptz ...) — drives alignment & rendering. */
  typeName?: string;
  isPk?: boolean;
  /** Initial width in px. */
  width?: number;
  /** Optional tooltip/extra info for header (e.g. full data type, comment). */
  description?: string;
  /** Short type label shown in the header (defaults to typeName). */
  typeLabel?: string;
}

export interface GridSort {
  col: number;
  dir: 'asc' | 'desc';
}

export interface CellPos {
  row: number;
  col: number;
}

/** A rectangular selection. Columns are DISPLAY indexes (after reorder / hide). */
export interface CellRange {
  start: CellPos;
  end: CellPos;
}

/** Selection expressed in data terms (what features usually need). */
export interface GridSelectionInfo {
  /** First / last selected row index (inclusive). */
  r0: number;
  r1: number;
  /** Selected DATA column indexes, in display order. */
  cols: number[];
  /** Cursor (focus) cell, data column index. */
  cursor: CellPos;
  /** Whole rows selected (all visible columns). */
  fullRows: boolean;
}

export interface EditorOption {
  label: string;
  value: CellValue;
}

/**
 * How a cell is edited:
 *  text   – inline single-line input
 *  choice – inline picker (bool, enum); `options` required
 *  long   – opens the value editor (multi-line text, JSON, arrays, bytea)
 */
export interface CellEditorSpec {
  kind: 'text' | 'choice' | 'long';
  options?: EditorOption[];
  nullable?: boolean;
  /** Hint shown in empty editors (e.g. "YYYY-MM-DD"). */
  placeholder?: string;
  /** Language for the long editor ("json" → pretty print + validation). */
  language?: 'json' | 'text';
  /** Long values: open the viewer first (Edit button switches to editing), e.g. bytea. */
  viewFirst?: boolean;
}

export interface GridMenuContext {
  kind: 'cell' | 'header' | 'rownum';
  /** Data column index (cells / header). */
  col: number;
  row: number;
  selection: GridSelectionInfo | null;
}

export type { CellValue };
