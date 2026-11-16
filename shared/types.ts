/**
 * Shared API contract between server and web.
 * Core types live here. Feature-specific types live in shared/<feature>.ts,
 * owned by that feature.
 */

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Never sent to the client; on update, `undefined` keeps the stored password. */
  password?: string;
  hasPassword?: boolean;
  database: string;
  sslMode: SslMode;
  /** Hex color tag shown in the UI (e.g. red for production). */
  color?: string;
  group?: string;
  /** Optional: refuse write statements unless confirmed in UI. */
  readOnly?: boolean;
  /** Free-form; e.g. statement_timeout in ms applied on connect. */
  statementTimeoutMs?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
}

export interface ServerInfo {
  version: string;        // full version() string
  versionNum: number;     // server_version_num, e.g. 180006
  currentUser: string;
  isSuperuser: boolean;
  databases: DatabaseInfo[];
}

export interface DatabaseInfo {
  name: string;
  owner: string;
  encoding: string;
  sizeBytes: number | null;
  isTemplate: boolean;
  allowConn: boolean;
}

export interface FieldInfo {
  name: string;
  dataTypeID: number;
  /** Human readable type name, e.g. "int4", "text", "jsonb". */
  typeName: string;
  /** If the column comes straight from a table: its oid / attnum (for editability). */
  tableID?: number;
  columnID?: number;
}

/** Cell values are JSON-safe: bigint/numeric come as strings, bytea as "\\x..." hex, dates as ISO strings. */
export type CellValue = string | number | boolean | null | object;

export interface ResultSet {
  /** The SQL command tag: SELECT, INSERT, UPDATE, CREATE ... */
  command: string;
  fields: FieldInfo[];
  rows: CellValue[][];
  rowCount: number | null;
  /** true if rows were truncated at maxRows. */
  truncated: boolean;
  durationMs: number;
  /** The statement text that produced this result (when multiple statements were run). */
  statement?: string;
}

export interface QueryNotice {
  severity: string;
  message: string;
}

export interface QueryError {
  message: string;
  code?: string;          // SQLSTATE
  detail?: string;
  hint?: string;
  position?: number;      // 1-based character offset into the submitted SQL
  where?: string;
  severity?: string;
  /** index of the failing statement when running multiple. */
  statementIndex?: number;
}

export interface QueryRequest {
  sql: string;
  /** Positional params ($1, $2...). */
  params?: unknown[];
  /** Max rows returned per result set; default 1000; 0 = unlimited (capped server-side at 1,000,000). */
  maxRows?: number;
  /** Client-generated id allowing cancellation via POST /cancel. */
  queryId?: string;
  /** Split SQL into statements and run each, returning one ResultSet per statement. Default true. */
  multi?: boolean;
  /** Run in a transaction that is rolled back (used for safe EXPLAIN ANALYZE etc). */
  rollback?: boolean;
  /**
   * Run on a dedicated, persistent server session (one per SQL editor tab) so that
   * BEGIN/COMMIT, SET, temp tables etc. survive across runs. Omit to use the pool.
   */
  sessionId?: string;
}

export type TxStatus = 'idle' | 'transaction' | 'error';

export interface QueryResponse {
  results: ResultSet[];
  notices: QueryNotice[];
  error?: QueryError;
  totalDurationMs: number;
  /** Only for session queries: transaction state after the run. */
  txStatus?: TxStatus;
}

export type DbObjectKind =
  | 'table' | 'partitioned_table' | 'view' | 'materialized_view' | 'foreign_table'
  | 'sequence' | 'function' | 'procedure' | 'aggregate' | 'type' | 'enum' | 'domain'
  | 'index' | 'trigger' | 'extension' | 'schema';

export interface SchemaInfo {
  name: string;
  owner: string;
  isSystem: boolean;
  comment?: string | null;
}

export interface DbObject {
  oid: number;
  schema: string;
  name: string;
  kind: DbObjectKind;
  /** functions: identity argument list, e.g. "integer, text" */
  args?: string;
  comment?: string | null;
  /** tables: estimated row count (reltuples) */
  estRows?: number | null;
  sizeBytes?: number | null;
}

export interface ColumnInfo {
  name: string;
  attnum: number;
  dataType: string;         // format_type() output, e.g. "character varying(255)"
  udtName: string;          // e.g. "varchar", "int4"
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  isGenerated: boolean;
  comment: string | null;
}

export interface ApiErrorBody {
  error: QueryError;
}
