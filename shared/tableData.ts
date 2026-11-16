/**
 * Table data API contract (owned by the Data Grid & Table Data team).
 * Prefix: /api/c/:connId/db/:db/table-data/:schema/:table/...
 */
import type { CellValue } from './types';

export type RelKind = 'table' | 'partitioned_table' | 'view' | 'materialized_view' | 'foreign_table';

export interface TableColumn {
  name: string;
  attnum: number;
  /** format_type() output, e.g. "character varying(32)". */
  dataType: string;
  /** pg_type.typname of the column type ("int4", "_text", "order_status" ...). */
  udtName: string;
  /** Element type name for arrays ("int4" for "_int4"), else null. */
  elemType: string | null;
  isArray: boolean;
  /** pg_type.typcategory: B bool, N numeric, S string, D datetime, U user (json, bytea ...), E enum, A array ... */
  category: string;
  /** Allowed labels for enum columns (also for arrays of enums). */
  enumValues: string[] | null;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  /** '' | 'a' (GENERATED ALWAYS AS IDENTITY) | 'd' (BY DEFAULT) */
  identity: '' | 'a' | 'd';
  isGenerated: boolean;
  comment: string | null;
  /** Can a value be written to this column via UPDATE / INSERT? */
  updatable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: RelKind;
  columns: TableColumn[];
  /** Columns that identify a row (primary key, else a NOT NULL unique index). Empty -> rows can't be updated/deleted. */
  keyColumns: string[];
  keySource: 'primary_key' | 'unique_index' | null;
  /** reltuples estimate (null for views). */
  estimatedRows: number | null;
  canSelect: boolean;
  canInsert: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** Connection is marked read-only in PG Studio. */
  connectionReadOnly: boolean;
  /** Human explanation when editing is (partially) unavailable. */
  readOnlyReason: string | null;
  comment: string | null;
}

export type FilterOp =
  | '=' | '<>' | '>' | '>=' | '<' | '<='
  | 'LIKE' | 'NOT LIKE' | 'ILIKE' | 'NOT ILIKE'
  | 'IS NULL' | 'IS NOT NULL'
  | 'IN' | 'NOT IN' | 'BETWEEN';

export interface FilterCondition {
  column: string;
  op: FilterOp;
  /** Single value; for IN a list; for BETWEEN [from, to]. Ignored for IS NULL / IS NOT NULL. */
  value?: string | null;
  values?: string[];
  /** Disabled conditions are kept in the UI but not applied. */
  enabled?: boolean;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface RowsQuery {
  filters?: FilterCondition[];
  /** Raw SQL WHERE expression (user-authored; executed in a READ ONLY transaction). */
  where?: string;
  sort?: SortSpec[];
}

export interface RowsRequest extends RowsQuery {
  offset: number;
  limit: number;
}

export interface RowsResponse {
  /** Column names in result order (= TableInfo.columns order). */
  columns: string[];
  rows: CellValue[][];
  hasMore: boolean;
  durationMs: number;
  /** The SELECT that was executed (with $n placeholders). */
  sql: string;
  /** Same query with values inlined (for display / opening in the SQL editor). */
  sqlLiteral: string;
}

export interface CountResponse {
  count: number;
  exact: boolean;
  durationMs: number;
}

/** Marker for "use the column default" in insert/update values. */
export interface DefaultValue { $default: true }
export type WriteValue = CellValue | DefaultValue;

export type RowChange =
  | { type: 'update'; key: Record<string, CellValue>; set: Record<string, WriteValue> }
  | { type: 'insert'; values: Record<string, WriteValue> }
  | { type: 'delete'; key: Record<string, CellValue> };

export interface CommitRequest {
  changes: RowChange[];
  /** Only render the SQL (with literals) without executing. */
  preview?: boolean;
}

export interface CommitResponse {
  /** Human readable SQL script (values inlined as literals). */
  sql: string;
  executed: boolean;
  inserted: number;
  updated: number;
  deleted: number;
  durationMs: number;
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

/** GET .../export?format=csv&q=<JSON RowsQuery>&columns=a,b — streams a file download. */
export interface ExportParams {
  format: ExportFormat;
  q?: string;
  columns?: string;
  /** Header row for CSV/TSV (default 1). */
  header?: '0' | '1';
}

// ---- CSV import (one server-side transaction across many batch requests)

export interface ImportBeginRequest {
  /** Target columns, in the order values are sent in each batch row. */
  columns: string[];
  truncate?: boolean;
}
export interface ImportBeginResponse { importId: string }
export interface ImportBatchRequest {
  /** Values as text (PostgreSQL input syntax) or null. */
  rows: (string | null)[][];
  /** 1-based source row number of rows[0] (for error messages). */
  firstRowNumber?: number;
}
export interface ImportBatchResponse { inserted: number; total: number }
export interface ImportErrorInfo {
  message: string;
  detail?: string;
  /** Source row number that failed (when it could be pinpointed). */
  rowNumber?: number;
  row?: (string | null)[];
}
