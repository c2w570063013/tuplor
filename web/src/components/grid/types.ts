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
}

export interface GridSort {
  col: number;
  dir: 'asc' | 'desc';
}

export interface CellPos {
  row: number;
  col: number;
}

export interface CellRange {
  start: CellPos;
  end: CellPos;
}

export type { CellValue };
