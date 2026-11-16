/** Backup & restore API contract (pg_dump / pg_restore / psql driven by the server). */

export type BinaryName = 'pg_dump' | 'pg_restore' | 'psql';

export interface BinaryInfo {
  name: BinaryName;
  path: string | null;
  /** e.g. "18.6" */
  version: string | null;
  major: number | null;
}

export interface BinDirCandidate {
  dir: string;
  version: string;
  major: number;
  source: string; // "PATH", "Homebrew", "Postgres.app", "custom", ...
}

export interface ToolsInfo {
  /** User-configured bin directory (persisted), if any. */
  customBinDir: string | null;
  /** Directory actually used. */
  binDir: string | null;
  binaries: Record<BinaryName, BinaryInfo>;
  candidates: BinDirCandidate[];
  serverVersion: string | null;
  serverMajor: number | null;
  /** 'ok' | tools older than server (pg_dump will refuse) | newer (fine, but note) | missing */
  status: 'ok' | 'older' | 'newer' | 'missing';
  message: string | null;
}

export type BackupFormat = 'custom' | 'plain' | 'directory' | 'tar';
export type RestoreFormat = BackupFormat | 'plain-gz';

export interface BackupOptions {
  format: BackupFormat;
  scope: 'database' | 'schemas' | 'tables';
  schemas: string[];
  /** "schema.table" */
  tables: string[];
  /** "schema.table" whose data is skipped (structure only). */
  excludeTableData: string[];
  schemaOnly: boolean;
  dataOnly: boolean;
  noOwner: boolean;
  noPrivileges: boolean;
  /** Emit DROP … IF EXISTS before CREATE (plain format; archives decide at restore time). */
  clean: boolean;
  /** Plain format: include CREATE DATABASE + \connect. */
  create: boolean;
  dataAs: 'copy' | 'inserts' | 'column-inserts';
  /** 0-9; null = pg_dump default. */
  compression: number | null;
  /** Parallel jobs (directory format only). */
  jobs: number;
  /** Without extension; sanitised server side. */
  fileName: string;
}

export interface RestoreOptions {
  /** Name of a file in the backups folder. */
  file: string;
  targetDb: string;
  createDb: boolean;
  clean: boolean;
  noOwner: boolean;
  noPrivileges: boolean;
  dataOnly: boolean;
  schemaOnly: boolean;
  singleTransaction: boolean;
  exitOnError: boolean;
  jobs: number;
}

export type JobStatus = 'running' | 'success' | 'error' | 'canceled';

export interface JobInfo {
  id: string;
  kind: 'backup' | 'restore';
  status: JobStatus;
  connId: string;
  connName: string;
  database: string;
  file: string;
  format: RestoreFormat;
  /** Command shown to the user (no secrets). */
  command: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  /** Output size so far (backup) or input size (restore). */
  bytes: number;
  /** 0..1 when it can be estimated. */
  progress: number | null;
  progressLabel: string | null;
  exitCode: number | null;
  lineCount: number;
  errors: string[];
  warnings: number;
  summary: JobSummary | null;
}

export interface JobSummary {
  /** After a restore: tables / est. rows now in the target database. */
  tables?: number;
  rows?: number;
  sizeBytes?: number;
  message: string;
}

export interface JobLogResponse {
  job: JobInfo;
  lines: LogLine[];
  /** Pass back as `since` to get only new lines. */
  next: number;
}

export interface LogLine {
  /** ms since job start */
  t: number;
  level: 'info' | 'error' | 'warning' | 'cmd';
  text: string;
}

export interface BackupFile {
  name: string;
  size: number;
  modifiedAt: string;
  format: RestoreFormat | 'unknown';
  database: string | null;
  connName: string | null;
  /** Description of what's inside, from the backup job (scope / options). */
  note: string | null;
}

export interface BackupTreeSchema {
  name: string;
  tables: { name: string; kind: 'table' | 'partitioned_table' | 'view' | 'materialized_view' | 'foreign_table' | 'sequence'; estRows: number | null; sizeBytes: number | null }[];
}
