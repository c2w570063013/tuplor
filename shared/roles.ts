/**
 * Roles & Users feature — API contract (server ⇄ web).
 *
 * Server-scoped:   /api/c/:connId/roles ...
 * Database-scoped: /api/c/:connId/db/:db/roles ...
 *
 * Every mutating endpoint accepts `dryRun: true` and then only returns the SQL it would run
 * (passwords are always masked as PASSWORD '********'). Passwords are never returned.
 */

export interface RoleMembership {
  /** The other role: for `memberOf` the granted (group) role, for `members` the member role. */
  role: string;
  admin: boolean;
  /** PG16+: INHERIT option of this grant (null on older servers). */
  inherit: boolean | null;
  /** PG16+: SET option of this grant (null on older servers). */
  set: boolean | null;
  grantor: string | null;
}

export interface RoleInfo {
  oid: number;
  name: string;
  canLogin: boolean;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassRls: boolean;
  /** -1 = unlimited */
  connLimit: number;
  /** ISO timestamp, 'infinity', or null (no expiry). */
  validUntil: string | null;
  /** null = unknown (current user cannot read pg_authid). */
  hasPassword: boolean | null;
  /** 'scram-sha-256' | 'md5' | null (unknown / none). Never the hash itself. */
  passwordType: 'scram-sha-256' | 'md5' | null;
  comment: string | null;
  /** Role-level settings (ALTER ROLE ... SET), e.g. ["search_path=app, public"]. */
  config: string[];
  memberOf: RoleMembership[];
  members: RoleMembership[];
  /** Built-in pg_* roles. */
  isSystem: boolean;
}

export interface RolesResponse {
  roles: RoleInfo[];
  currentUser: string;
  isSuperuser: boolean;
  /** current user may CREATE ROLE (superuser or CREATEROLE). */
  canCreateRole: boolean;
  /** current user can read pg_authid (password presence is known). */
  canReadPasswords: boolean;
  versionNum: number;
}

/** Desired role state. For ALTER, omitted fields are left unchanged. */
export interface RoleSpec {
  name: string;
  canLogin?: boolean;
  superuser?: boolean;
  createDb?: boolean;
  createRole?: boolean;
  inherit?: boolean;
  replication?: boolean;
  bypassRls?: boolean;
  /** -1 = unlimited */
  connLimit?: number;
  /** ISO timestamp / any PG timestamptz literal; null = never expires ('infinity'). */
  validUntil?: string | null;
  /** New password. Empty / undefined = unchanged (ALTER) or none (CREATE). */
  password?: string;
  /** ALTER only: PASSWORD NULL. */
  removePassword?: boolean;
  /** '' or null removes the comment. */
  comment?: string | null;
  /** CREATE only: IN ROLE ... */
  memberOf?: string[];
}

export interface RoleMutationRequest {
  spec: RoleSpec;
  dryRun?: boolean;
}

/** Result of every mutating endpoint. `sql` is always safe to display (passwords masked). */
export interface SqlResult {
  sql: string;
  executed: boolean;
}

export interface MembershipRequest {
  action: 'grant' | 'revoke';
  /** Granted (group) roles. */
  roles: string[];
  /** Roles receiving / losing the membership. */
  members: string[];
  /** grant: WITH ADMIN OPTION. revoke: only REVOKE ADMIN OPTION FOR (keep membership). */
  adminOption?: boolean;
  /** grant, PG16+: INHERIT TRUE/FALSE (undefined = server default). */
  inheritOption?: boolean;
  /** grant, PG16+: SET TRUE/FALSE (undefined = server default). */
  setOption?: boolean;
  /** revoke: CASCADE */
  cascade?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------- drop

export interface RoleDependencySummary {
  /** null = shared objects (databases, tablespaces). */
  database: string | null;
  owned: number;
  privileges: number;
  policies: number;
}

export interface RoleDependencyObject {
  /** pg_describe_object() text, e.g. "table shop.orders" */
  description: string;
  kind: 'owner' | 'privilege' | 'policy' | 'other';
}

export interface RoleDependencies {
  role: string;
  database: string;
  /** Objects in the selected database (capped at 500). */
  objects: RoleDependencyObject[];
  totalInDatabase: number;
  /** Counts per database (incl. the selected one), from pg_shdepend. */
  perDatabase: RoleDependencySummary[];
  /** Databases owned by the role (must be reassigned/dropped first). */
  ownedDatabases: string[];
}

export interface DropRoleRequest {
  /** REASSIGN OWNED BY role TO reassignTo */
  reassignTo?: string | null;
  /** DROP OWNED BY role (drops remaining owned objects + revokes privileges in this database). */
  dropOwned?: boolean;
  /** DROP OWNED ... CASCADE */
  cascade?: boolean;
  /** DROP ROLE */
  dropRole?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------- privileges

export type PrivObjectType =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'foreign_table'
  | 'column'
  | 'sequence'
  | 'function'
  | 'procedure';

export interface PrivilegeGrant {
  privilege: string;
  grantable: boolean;
  grantor: string;
}

export interface PrivilegeEntry {
  objectType: PrivObjectType;
  schema: string | null;
  name: string;
  /** column privileges: the column. */
  column?: string | null;
  /** functions: oid (used to target the routine), signature = "schema.fn(int4, text)". */
  oid?: number | null;
  signature?: string | null;
  /** functions: argument types only, e.g. "bigint, text". */
  args?: string | null;
  /** The grantee is the object owner (owner's own ACL entry). */
  isOwner: boolean;
  privileges: PrivilegeGrant[];
}

export interface PrivilegesResponse {
  role: string;
  database: string;
  entries: PrivilegeEntry[];
}

/** Kinds accepted by the grant/revoke endpoint and the target picker. */
export type GrantTargetType =
  | 'database'
  | 'schema'
  | 'table'
  | 'sequence'
  | 'function'
  | 'all_tables'
  | 'all_sequences'
  | 'all_functions';

export interface GrantTarget {
  /** null for databases / schemas */
  schema: string | null;
  name: string;
  /** functions only */
  oid?: number | null;
  /** Display label, e.g. "shop.orders" or "shop.total(integer)" */
  label: string;
  /** table, view, materialized_view, foreign_table, partitioned_table, sequence, function, procedure, schema, database */
  kind: string;
}

export interface GrantRef {
  schema?: string | null;
  name: string;
  /** required for functions */
  oid?: number | null;
}

export interface PrivilegeRequest {
  action: 'grant' | 'revoke';
  targetType: GrantTargetType;
  /** For all_* types: the schemas (name only). */
  objects: GrantRef[];
  /** Privilege keywords or ['ALL']. */
  privileges: string[];
  /** Optional column list (table targets only). */
  columns?: string[];
  grantees: string[];
  /** grant: WITH GRANT OPTION; revoke: GRANT OPTION FOR (only revoke the grant option). */
  grantOption?: boolean;
  /** revoke: CASCADE */
  cascade?: boolean;
  dryRun?: boolean;
}

/** Privileges valid per grant target type. */
export const PRIVILEGES_BY_TARGET: Record<GrantTargetType, string[]> = {
  database: ['CONNECT', 'CREATE', 'TEMPORARY'],
  schema: ['USAGE', 'CREATE'],
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  all_tables: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  all_sequences: ['USAGE', 'SELECT', 'UPDATE'],
  function: ['EXECUTE'],
  all_functions: ['EXECUTE'],
};

/** Privileges that need a minimum server version. */
export const PRIVILEGE_MIN_VERSION: Record<string, number> = { MAINTAIN: 170000 };
