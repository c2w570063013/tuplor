/**
 * Explorer & Structure API contract (owned by the Explorer & Structure team).
 * Endpoints live under /api/c/:connId/db/:db/schema/...
 */
import type { DbObjectKind } from './types';

export interface ColumnDetail {
  attnum: number;
  name: string;
  /** format_type() output, e.g. "character varying(120)" */
  dataType: string;
  typeOid: number;
  /** pg_type.typname, e.g. "varchar", "_int4" */
  typeName: string;
  typeSchema: string;
  /** pg_type.typtype: b base, c composite, d domain, e enum, r range, m multirange, p pseudo */
  typeKind: string;
  nullable: boolean;
  /** Default expression (not for generated columns). */
  default: string | null;
  /** Expression of a GENERATED ... STORED/VIRTUAL column. */
  generatedExpr: string | null;
  /** '' | 'a' (ALWAYS) | 'd' (BY DEFAULT) */
  identity: string;
  /** '' | 's' (stored) | 'v' (virtual) */
  generated: string;
  collation: string | null;
  comment: string | null;
  /** Inherited from a parent (partition / inheritance), cannot be dropped here. */
  inherited: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  /** Outgoing foreign key (first one) that this column is part of. */
  fk: { constraint: string; schema: string; table: string; column: string } | null;
  /** From pg_stats when the table has been analyzed. */
  nullFrac: number | null;
  nDistinct: number | null;
  avgWidth: number | null;
}

export interface IndexDetail {
  oid: number;
  name: string;
  definition: string;
  method: string;
  isUnique: boolean;
  isPrimary: boolean;
  isValid: boolean;
  /** Name of the constraint backed by this index (PK / UNIQUE / EXCLUDE) */
  constraint: string | null;
  columns: string[];
  include: string[];
  predicate: string | null;
  sizeBytes: number;
  scans: number | null;
  comment: string | null;
  /** Child index of a partitioned index (created automatically). */
  isInherited: boolean;
}

/** p primary, u unique, f foreign, c check, x exclusion, t constraint trigger */
export type ConstraintType = 'p' | 'u' | 'f' | 'c' | 'x' | 't';

export interface ConstraintDetail {
  oid: number;
  name: string;
  type: ConstraintType;
  definition: string;
  columns: string[];
  deferrable: boolean;
  deferred: boolean;
  validated: boolean;
  /** false = inherited from parent table */
  isLocal: boolean;
  comment: string | null;
  refSchema: string | null;
  refTable: string | null;
  refColumns: string[];
  /** a no action, r restrict, c cascade, n set null, d set default */
  onUpdate: string | null;
  onDelete: string | null;
}

export interface ForeignKeyDetail {
  oid: number;
  name: string;
  definition: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  onUpdate: string;
  onDelete: string;
  validated: boolean;
}

export interface TriggerDetail {
  oid: number;
  name: string;
  definition: string;
  /** O enabled, D disabled, R replica, A always */
  enabled: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  level: 'ROW' | 'STATEMENT';
  functionSchema: string;
  functionName: string;
  functionOid: number;
  isInherited: boolean;
  isConstraint: boolean;
  comment: string | null;
}

export interface PartitionDetail {
  oid: number;
  schema: string;
  name: string;
  bound: string;
  kind: DbObjectKind;
  estRows: number;
  sizeBytes: number;
}

export interface TableStats {
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  toastBytes: number;
  estRows: number;
  pages: number;
  liveTuples: number | null;
  deadTuples: number | null;
  seqScan: number | null;
  seqTupRead: number | null;
  idxScan: number | null;
  idxTupFetch: number | null;
  inserts: number | null;
  updates: number | null;
  deletes: number | null;
  hotUpdates: number | null;
  modsSinceAnalyze: number | null;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  vacuumCount: number | null;
  autovacuumCount: number | null;
  analyzeCount: number | null;
  autoanalyzeCount: number | null;
}

export interface GrantDetail {
  grantee: string;
  grantor: string;
  privilege: string;
  grantable: boolean;
  /** Column-level grant */
  column?: string | null;
}

export interface PolicyDetail {
  name: string;
  permissive: string;
  roles: string[];
  cmd: string;
  using: string | null;
  check: string | null;
}

export interface TableDetails {
  oid: number;
  schema: string;
  name: string;
  kind: DbObjectKind;
  owner: string;
  comment: string | null;
  tablespace: string | null;
  /** p permanent, u unlogged, t temp */
  persistence: string;
  accessMethod: string | null;
  rlsEnabled: boolean;
  rlsForced: boolean;
  options: string[];
  partitionKey: string | null;
  partitionOf: { schema: string; name: string; bound: string } | null;
  inherits: { schema: string; name: string }[];
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  constraints: ConstraintDetail[];
  foreignKeys: ForeignKeyDetail[];
  referencedBy: ForeignKeyDetail[];
  triggers: TriggerDetail[];
  partitions: PartitionDetail[];
  stats: TableStats;
  grants: GrantDetail[];
  policies: PolicyDetail[];
}

export interface DependencyRef {
  oid: number;
  schema: string;
  name: string;
  kind: DbObjectKind;
}

export interface ObjectBase {
  oid: number;
  schema: string;
  name: string;
  owner: string;
  comment: string | null;
  /** Full CREATE statement(s). */
  ddl: string;
}

export interface ViewDetails extends ObjectBase {
  kind: 'view' | 'materialized_view';
  definition: string;
  columns: { name: string; dataType: string; comment: string | null }[];
  dependents: DependencyRef[];
  dependsOn: DependencyRef[];
  isPopulated: boolean | null;
  sizeBytes: number | null;
  indexes: IndexDetail[];
  grants: GrantDetail[];
}

export interface FunctionParam {
  mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC' | 'TABLE';
  name: string | null;
  type: string;
  default: string | null;
}

export interface FunctionDetails extends ObjectBase {
  kind: 'function' | 'procedure' | 'aggregate';
  identityArgs: string;
  arguments: string;
  result: string | null;
  language: string;
  volatility: 'immutable' | 'stable' | 'volatile';
  strict: boolean;
  securityDefiner: boolean;
  leakproof: boolean;
  parallel: 'safe' | 'restricted' | 'unsafe';
  cost: number;
  rows: number | null;
  config: string[];
  params: FunctionParam[];
  /** Full CREATE OR REPLACE text (pg_get_functiondef), null for aggregates. */
  definition: string | null;
  usedByTriggers: { schema: string; table: string; trigger: string }[];
  grants: GrantDetail[];
}

export interface SequenceDetails extends ObjectBase {
  kind: 'sequence';
  dataType: string;
  start: string;
  min: string;
  max: string;
  increment: string;
  cache: string;
  cycle: boolean;
  lastValue: string | null;
  isCalled: boolean;
  ownedBy: { schema: string; table: string; column: string } | null;
  identity: boolean;
}

export interface TypeUsage {
  schema: string;
  table: string;
  column: string;
  kind: DbObjectKind;
}

export interface EnumDetails extends ObjectBase {
  kind: 'enum';
  values: string[];
  usedBy: TypeUsage[];
}

export interface DomainDetails extends ObjectBase {
  kind: 'domain';
  baseType: string;
  notNull: boolean;
  default: string | null;
  collation: string | null;
  constraints: { name: string; definition: string; validated: boolean }[];
  usedBy: TypeUsage[];
}

export interface CompositeDetails extends ObjectBase {
  kind: 'type';
  attributes: { name: string; dataType: string; comment: string | null }[];
  usedBy: TypeUsage[];
}

export type ObjectDetails = ViewDetails | FunctionDetails | SequenceDetails | EnumDetails | DomainDetails | CompositeDetails;

export interface ExtensionInfo {
  name: string;
  installedVersion: string | null;
  defaultVersion: string | null;
  schema: string | null;
  comment: string | null;
}

export interface TypeSuggestion {
  /** As it should be written in DDL, e.g. "shop.order_status" or "integer" */
  name: string;
  kind: 'base' | 'enum' | 'domain' | 'composite' | 'range';
  /** e.g. "Numeric types", "shop" */
  group: string;
  description?: string;
}

export interface ApplyRequest {
  statements: string[];
  /** Run all statements in one transaction (default true). Must be false for CONCURRENTLY / VACUUM / CREATE DATABASE. */
  transaction?: boolean;
}

export interface ApplyResponse {
  ok: true;
  durationMs: number;
}
