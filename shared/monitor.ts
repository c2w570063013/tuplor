/**
 * Monitoring & Admin API types (server ⇄ web).
 * Server-scoped endpoints: /api/c/:connId/monitor/...
 * Database-scoped endpoints: /api/c/:connId/db/:db/monitor/...
 */

/** One poll of cumulative counters + gauges. Rates are computed client-side from deltas. */
export interface MonitorSnapshot {
  /** Server clock (epoch ms) when the snapshot was taken. */
  ts: number;
  version: string;
  versionNum: number;
  startedAt: string;
  uptimeSec: number;
  inRecovery: boolean;
  maxConnections: number;
  superuserReserved: number;
  connections: { total: number; active: number; idle: number; idleInTx: number; waiting: number; other: number };
  /** Size of the database the dashboard is opened on. */
  dbSizeBytes: number | null;
  clusterSizeBytes: number | null;
  databaseCount: number;
  /** Cumulative counters, summed over all databases (pg_stat_database). Numbers (may lose precision above 2^53, fine for rates). */
  counters: {
    xactCommit: number;
    xactRollback: number;
    tupReturned: number;
    tupFetched: number;
    tupInserted: number;
    tupUpdated: number;
    tupDeleted: number;
    blksRead: number;
    blksHit: number;
    deadlocks: number;
    tempFiles: number;
    tempBytes: number;
    conflicts: number;
  };
  /** Bytes since 0/0 (pg_current_wal_lsn or replay lsn on a standby). */
  walBytes: number | null;
  /** On a standby: seconds since last replayed transaction. */
  replayLagSec: number | null;
  /** On a primary: connected replicas. */
  replicas: ReplicaInfo[];
  statsReset: string | null;
}

export interface ReplicaInfo {
  pid: number;
  applicationName: string;
  clientAddr: string | null;
  state: string;
  syncState: string;
  replayLagBytes: number | null;
  replayLagSec: number | null;
}

export interface ActivitySession {
  pid: number;
  user: string | null;
  database: string | null;
  application: string;
  client: string | null;
  backendType: string;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  backendStart: string | null;
  xactStart: string | null;
  queryStart: string | null;
  /** ms since query_start (at fetch time). */
  queryAgeMs: number | null;
  /** ms since xact_start (at fetch time). */
  xactAgeMs: number | null;
  query: string;
  blockedBy: number[];
  isSelf: boolean;
}

export interface LockInfo {
  pid: number;
  lockType: string;
  mode: string;
  granted: boolean;
  database: string | null;
  relation: string | null;
  page: number | null;
  tuple: number | null;
  transactionId: string | null;
  virtualXid: string | null;
  user: string | null;
  state: string | null;
  query: string;
  waitStartAgeMs: number | null;
}

export interface BlockingNode {
  pid: number;
  user: string | null;
  database: string | null;
  application: string;
  state: string | null;
  waitEvent: string | null;
  queryAgeMs: number | null;
  xactAgeMs: number | null;
  query: string;
  blockedBy: number[];
}

export interface LocksResponse {
  locks: LockInfo[];
  /** Sessions involved in blocking (blockers and waiters). */
  blocking: BlockingNode[];
}

export interface TableStat {
  schema: string;
  name: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  liveTuples: number;
  deadTuples: number;
  deadPct: number;
  seqScan: number;
  idxScan: number;
  inserts: number;
  updates: number;
  deletes: number;
  hotUpdates: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  vacuumCount: number;
  autovacuumCount: number;
  /** Estimated wasted bytes (heuristic, based on pg_stats widths). */
  bloatBytes: number | null;
  bloatPct: number | null;
}

export interface IndexStat {
  schema: string;
  table: string;
  name: string;
  sizeBytes: number;
  scans: number;
  tupRead: number;
  tupFetched: number;
  isUnique: boolean;
  isPrimary: boolean;
  isValid: boolean;
  definition: string;
  /** Other index names with identical definition on the same table. */
  duplicateOf: string[];
  unused: boolean;
}

export type MaintenanceOp = 'VACUUM' | 'VACUUM ANALYZE' | 'VACUUM FULL' | 'ANALYZE' | 'REINDEX';

export interface MaintenanceRequest {
  op: MaintenanceOp;
  schema: string;
  name: string;
  /** For REINDEX: target kind. */
  kind?: 'table' | 'index';
  dryRun?: boolean;
}

export interface StatementsStatus {
  installed: boolean;
  preloaded: boolean;
  available: boolean;
  version?: string;
  /** Message when installed but not usable (e.g. not preloaded). */
  error?: string;
  canCreate: boolean;
}

export interface StatementStat {
  queryId: string | null;
  query: string;
  user: string | null;
  database: string | null;
  calls: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  stddevMs: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  hitPct: number | null;
  /** Percent of total time across all statements. */
  pctTotal: number;
}

export interface StatementsResponse {
  status: StatementsStatus;
  rows: StatementStat[];
}

export type StatementsSort = 'total' | 'mean' | 'calls' | 'rows' | 'io';

export interface SettingRow {
  name: string;
  setting: string;
  unit: string | null;
  category: string;
  shortDesc: string;
  extraDesc: string | null;
  context: string;
  vartype: string;
  source: string;
  minVal: string | null;
  maxVal: string | null;
  enumVals: string[] | null;
  bootVal: string | null;
  resetVal: string | null;
  pendingRestart: boolean;
  /** Human readable value with unit (e.g. "128 MB"). */
  display: string;
  nonDefault: boolean;
}

export interface DatabaseRow {
  name: string;
  oid: number;
  owner: string;
  encoding: string;
  collate: string | null;
  ctype: string | null;
  isTemplate: boolean;
  allowConn: boolean;
  connLimit: number;
  tablespace: string;
  sizeBytes: number | null;
  connections: number;
  xactCommit: number;
  xactRollback: number;
  cacheHitPct: number | null;
  deadlocks: number;
  comment: string | null;
}

export interface CreateDatabaseRequest {
  name: string;
  owner?: string;
  encoding?: string;
  template?: string;
  locale?: string;
  tablespace?: string;
  connLimit?: number;
  comment?: string;
  dryRun?: boolean;
}

export interface DropDatabaseRequest {
  name: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface DatabaseFormMeta {
  roles: string[];
  templates: string[];
  tablespaces: string[];
  encodings: string[];
  currentUser: string;
}

export interface SqlPreview {
  sql: string;
}
