import type { FastifyInstance } from 'fastify';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type {
  DropRoleRequest, GrantRef, GrantTarget, GrantTargetType, MembershipRequest, PrivilegeEntry, PrivilegeRequest,
  PrivilegesResponse, RoleDependencies, RoleDependencyObject, RoleDependencySummary, RoleInfo, RoleMembership,
  RoleMutationRequest, RoleSpec, RolesResponse, SqlResult,
} from '../../../shared/roles';
import { PRIVILEGES_BY_TARGET, PRIVILEGE_MIN_VERSION } from '../../../shared/roles';
import { queryRows, withTransaction } from '../db';
import { HttpError } from '../lib/errors';
import { quoteIdent, quoteLiteral } from '../lib/sql';

/**
 * Roles & Users.
 *   GET  /api/c/:connId/roles                         list roles (+ memberships)
 *   POST /api/c/:connId/roles                         CREATE ROLE       { spec, dryRun }
 *   PUT  /api/c/:connId/roles/:name                   ALTER ROLE (diff) { spec, dryRun }
 *   POST /api/c/:connId/roles/membership              GRANT/REVOKE role membership
 *   GET  /api/c/:connId/db/:db/roles/targets?type=    objects for the grant dialog
 *   POST /api/c/:connId/db/:db/roles/privileges       GRANT/REVOKE object privileges
 *   GET  /api/c/:connId/db/:db/roles/:name/privileges explicit grants of a role in :db
 *   GET  /api/c/:connId/db/:db/roles/:name/dependencies  objects owned / privileges (pg_shdepend)
 *   POST /api/c/:connId/db/:db/roles/:name/drop       REASSIGN OWNED / DROP OWNED / DROP ROLE
 *
 * All SQL is built here. Mutations accept { dryRun: true } and return the SQL with any password
 * masked. Passwords never appear in responses, errors or logs.
 */

const MASK = "'********'";

/** One statement: what is executed and what may be shown. */
interface Stmt {
  sql: string;
  shown: string;
}
const stmt = (sql: string, shown = sql): Stmt => ({ sql, shown });

// ---------------------------------------------------------------- identifiers

/** Keywords that need quoting (everything except unreserved), cached per connection. */
const keywordCache = new Map<string, Promise<Set<string>>>();

/** Returns an identifier quoter with PostgreSQL's quote_ident() rules (quote only when needed). */
async function identQuoter(connId: string, db?: string): Promise<(name: string) => string> {
  let p = keywordCache.get(connId);
  if (!p) {
    p = queryRows<{ word: string }>(connId, db, `SELECT word FROM pg_get_keywords() WHERE catcode <> 'U'`)
      .then((rows) => new Set(rows.map((r) => r.word)));
    p.catch(() => keywordCache.delete(connId));
    keywordCache.set(connId, p);
  }
  let kw: Set<string>;
  try {
    kw = await p;
  } catch {
    return quoteIdent;
  }
  return (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) && !kw.has(name) ? name : quoteIdent(name));
}

function requireName(name: unknown, what = 'Role name'): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, `${what} is required`);
  if (name.length > 63) throw new HttpError(400, `${what} is too long (max 63 characters)`);
  return name;
}

function nameList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, `At least one ${what} is required`);
  return v.map((x) => requireName(x, what));
}

// ---------------------------------------------------------------- passwords

/** SCRAM-SHA-256 verifier, same format as libpq's PQencryptPasswordConn (psql \password). */
function scramVerifier(password: string, iterations: number): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

interface PasswordCtx {
  /** Secrets to scrub from errors. */
  secrets: string[];
  scramIterations: number;
  passwordEncryption: string;
}

/**
 * The literal sent to the server for a password. For printable-ASCII passwords (where SASLprep is the
 * identity) we send a pre-computed SCRAM verifier, like psql's \password does, so the plaintext never
 * reaches the server (or its statement log). Other passwords are sent as an escaped literal.
 */
function passwordLiteral(password: string, ctx: PasswordCtx): string {
  ctx.secrets.push(password);
  let lit: string;
  if (ctx.passwordEncryption === 'scram-sha-256' && /^[\x20-\x7e]*$/.test(password)) {
    const v = scramVerifier(password, ctx.scramIterations);
    ctx.secrets.push(v);
    lit = quoteLiteral(v);
  } else {
    lit = quoteLiteral(password);
  }
  ctx.secrets.push(lit);
  return lit;
}

async function passwordCtx(connId: string): Promise<PasswordCtx> {
  const [r] = await queryRows<{ enc: string | null; iter: string | null }>(connId, undefined, `
    SELECT current_setting('password_encryption', true) AS enc, current_setting('scram_iterations', true) AS iter`);
  const iter = Number(r?.iter) || 4096;
  return { secrets: [], scramIterations: iter, passwordEncryption: r?.enc || 'scram-sha-256' };
}

/** Remove any secret from a (pg) error before it is serialized or logged. */
function scrub(e: any, secrets: string[]): any {
  const list = secrets.filter((s) => s && s.length >= 1).sort((a, b) => b.length - a.length);
  if (!list.length || !e || typeof e !== 'object') return e;
  for (const k of ['message', 'detail', 'hint', 'where', 'internalQuery', 'stack']) {
    if (typeof e[k] === 'string') for (const s of list) e[k] = e[k].split(s).join('********');
  }
  return e;
}

async function execute(
  connId: string,
  db: string | undefined,
  stmts: Stmt[],
  dryRun: boolean | undefined,
  secrets: string[] = [],
): Promise<SqlResult> {
  const shown = stmts.map((s) => s.shown + ';').join('\n');
  if (dryRun || stmts.length === 0) return { sql: shown, executed: false };
  try {
    await withTransaction(connId, db, async (c) => {
      for (const s of stmts) await c.query(s.sql);
    });
  } catch (e) {
    throw scrub(e, secrets);
  }
  return { sql: shown, executed: true };
}

// ---------------------------------------------------------------- role listing

const ROLE_COLUMNS = `
  r.oid::int AS oid, r.rolname AS name, r.rolcanlogin AS "canLogin", r.rolsuper AS superuser,
  r.rolcreatedb AS "createDb", r.rolcreaterole AS "createRole", r.rolinherit AS inherit,
  r.rolreplication AS replication, r.rolbypassrls AS "bypassRls", r.rolconnlimit AS "connLimit",
  to_json(r.rolvaliduntil) #>> '{}' AS "validUntil",
  COALESCE(to_json(r.rolconfig), '[]'::json)::text AS config,
  shobj_description(r.oid, 'pg_authid') AS comment,
  r.rolname ~ '^pg_' AS "isSystem"`;

type RoleRow = Omit<RoleInfo, 'config' | 'memberOf' | 'members' | 'hasPassword' | 'passwordType'> & { config: string };

async function serverContext(connId: string) {
  const [ctx] = await queryRows<{ currentUser: string; isSuperuser: boolean; canCreateRole: boolean; versionNum: number; canReadPasswords: boolean }>(
    connId, undefined, `
    SELECT current_user AS "currentUser",
           r.rolsuper AS "isSuperuser",
           (r.rolsuper OR r.rolcreaterole) AS "canCreateRole",
           current_setting('server_version_num')::int AS "versionNum",
           has_table_privilege('pg_catalog.pg_authid', 'SELECT') AS "canReadPasswords"
      FROM pg_roles r WHERE r.rolname = current_user`);
  return ctx;
}

async function getRole(connId: string, name: string): Promise<RoleRow | undefined> {
  const [r] = await queryRows<RoleRow>(connId, undefined, `SELECT ${ROLE_COLUMNS} FROM pg_roles r WHERE r.rolname = $1`, [name]);
  return r;
}

async function listRoles(connId: string): Promise<RolesResponse> {
  const ctx = await serverContext(connId);
  const rows = await queryRows<RoleRow>(connId, undefined, `SELECT ${ROLE_COLUMNS} FROM pg_roles r ORDER BY r.rolname`);
  const pg16 = ctx.versionNum >= 160000;
  const mem = await queryRows<{ role: string; member: string; admin: boolean; inherit: boolean | null; set: boolean | null; grantor: string | null }>(
    connId, undefined, `
    SELECT r.rolname AS role, u.rolname AS member, m.admin_option AS admin,
           ${pg16 ? 'm.inherit_option' : 'NULL::bool'} AS inherit,
           ${pg16 ? 'm.set_option' : 'NULL::bool'} AS "set",
           g.rolname AS grantor
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
      LEFT JOIN pg_roles g ON g.oid = m.grantor
     ORDER BY r.rolname, u.rolname`);
  const pw = new Map<string, 'scram-sha-256' | 'md5' | 'other' | null>();
  if (ctx.canReadPasswords) {
    // Only the *kind* of password is read — the hash itself never leaves the database.
    const p = await queryRows<{ name: string; kind: 'scram-sha-256' | 'md5' | 'other' | null }>(connId, undefined, `
      SELECT rolname AS name,
             CASE WHEN rolpassword IS NULL THEN NULL
                  WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram-sha-256'
                  WHEN rolpassword LIKE 'md5%' THEN 'md5'
                  ELSE 'other' END AS kind
        FROM pg_authid`);
    for (const r of p) pw.set(r.name, r.kind);
  }
  const memberOf = new Map<string, RoleMembership[]>();
  const members = new Map<string, RoleMembership[]>();
  for (const m of mem) {
    const base = { admin: m.admin, inherit: m.inherit, set: m.set, grantor: m.grantor };
    (memberOf.get(m.member) ?? memberOf.set(m.member, []).get(m.member)!).push({ role: m.role, ...base });
    (members.get(m.role) ?? members.set(m.role, []).get(m.role)!).push({ role: m.member, ...base });
  }
  const roles: RoleInfo[] = rows.map((r) => {
    const kind = pw.get(r.name);
    return {
      ...r,
      config: safeJsonArray(r.config),
      hasPassword: ctx.canReadPasswords ? kind != null : null,
      passwordType: kind === 'scram-sha-256' || kind === 'md5' ? kind : null,
      memberOf: memberOf.get(r.name) ?? [],
      members: members.get(r.name) ?? [],
    };
  });
  return { roles, ...ctx };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- CREATE / ALTER ROLE

const ATTRS: { key: keyof RoleSpec; on: string; off: string; def: boolean }[] = [
  { key: 'superuser', on: 'SUPERUSER', off: 'NOSUPERUSER', def: false },
  { key: 'createDb', on: 'CREATEDB', off: 'NOCREATEDB', def: false },
  { key: 'createRole', on: 'CREATEROLE', off: 'NOCREATEROLE', def: false },
  { key: 'inherit', on: 'INHERIT', off: 'NOINHERIT', def: true },
  { key: 'canLogin', on: 'LOGIN', off: 'NOLOGIN', def: false },
  { key: 'replication', on: 'REPLICATION', off: 'NOREPLICATION', def: false },
  { key: 'bypassRls', on: 'BYPASSRLS', off: 'NOBYPASSRLS', def: false },
];

function validConnLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < -1 || n > 1_000_000) throw new HttpError(400, 'Connection limit must be an integer ≥ -1');
  return n;
}

function validUntilLiteral(v: string | null): string {
  if (v === null || v === '' || v.toLowerCase() === 'infinity') return `'infinity'`;
  if (typeof v !== 'string' || v.length > 64) throw new HttpError(400, 'Invalid "valid until" timestamp');
  return quoteLiteral(v);
}

function sameTimestamp(a: string | null, b: string | null): boolean {
  const norm = (x: string | null) => (x == null || x === '' || x === 'infinity' ? 'infinity' : x);
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const ta = Date.parse(na);
  const tb = Date.parse(nb);
  return !isNaN(ta) && ta === tb;
}

/** Options clause for CREATE/ALTER ROLE. Returns [real, shown]. */
function optionClauses(
  spec: RoleSpec,
  current: RoleRow | undefined,
  pw: PasswordCtx,
): { real: string[]; shown: string[] } {
  const real: string[] = [];
  const shown: string[] = [];
  const add = (r: string, s = r) => { real.push(r); shown.push(s); };
  for (const a of ATTRS) {
    const v = spec[a.key];
    if (typeof v !== 'boolean') continue;
    const cur = current ? (current as any)[a.key] as boolean : a.def;
    if (v !== cur) add(v ? a.on : a.off);
  }
  if (spec.connLimit !== undefined && spec.connLimit !== null) {
    const n = validConnLimit(spec.connLimit);
    if (n !== (current ? current.connLimit : -1)) add(`CONNECTION LIMIT ${n}`);
  }
  if (spec.validUntil !== undefined) {
    if (!sameTimestamp(spec.validUntil, current ? current.validUntil : null)) add(`VALID UNTIL ${validUntilLiteral(spec.validUntil)}`);
  }
  if (spec.password) {
    if (spec.password.length > 1000) throw new HttpError(400, 'Password is too long');
    add(`PASSWORD ${passwordLiteral(spec.password, pw)}`, `PASSWORD ${MASK}`);
  } else if (spec.removePassword && current) {
    add('PASSWORD NULL');
  }
  return { real, shown };
}

function normComment(c: string | null | undefined): string | null {
  return c == null || c.trim() === '' ? null : c;
}

async function buildCreate(connId: string, spec: RoleSpec, pw: PasswordCtx): Promise<Stmt[]> {
  const name = requireName(spec.name);
  const q = await identQuoter(connId);
  const { real, shown } = optionClauses(spec, undefined, pw);
  const inRole = (spec.memberOf ?? []).map((r) => q(requireName(r, 'Role')));
  const tail = inRole.length ? ` IN ROLE ${inRole.join(', ')}` : '';
  const head = `CREATE ROLE ${q(name)}`;
  const out: Stmt[] = [
    stmt(
      head + (real.length ? ' WITH ' + real.join(' ') : '') + tail,
      head + (shown.length ? ' WITH ' + shown.join(' ') : '') + tail,
    ),
  ];
  const comment = normComment(spec.comment);
  if (comment) out.push(stmt(`COMMENT ON ROLE ${q(name)} IS ${quoteLiteral(comment)}`));
  return out;
}

async function buildAlter(connId: string, oldName: string, spec: RoleSpec, pw: PasswordCtx): Promise<Stmt[]> {
  const current = await getRole(connId, oldName);
  if (!current) throw new HttpError(404, `Role "${oldName}" does not exist`);
  const q = await identQuoter(connId);
  const out: Stmt[] = [];
  const newName = spec.name === undefined ? oldName : requireName(spec.name);
  if (newName !== oldName) out.push(stmt(`ALTER ROLE ${q(oldName)} RENAME TO ${q(newName)}`));
  // A rename clears an MD5 password, so set attributes/password after renaming.
  const { real, shown } = optionClauses(spec, current, pw);
  if (real.length) {
    out.push(stmt(`ALTER ROLE ${q(newName)} WITH ${real.join(' ')}`, `ALTER ROLE ${q(newName)} WITH ${shown.join(' ')}`));
  }
  if (spec.comment !== undefined) {
    const c = normComment(spec.comment);
    if (c !== normComment(current.comment)) out.push(stmt(`COMMENT ON ROLE ${q(newName)} IS ${quoteLiteral(c)}`));
  }
  return out;
}

// ---------------------------------------------------------------- membership

async function buildMembership(connId: string, req: MembershipRequest, versionNum: number): Promise<Stmt[]> {
  const q = await identQuoter(connId);
  const roles = nameList(req.roles, 'role').map(q).join(', ');
  const members = nameList(req.members, 'member').map(q).join(', ');
  if (req.action === 'grant') {
    const opts: string[] = [];
    if (versionNum >= 160000) {
      if (req.adminOption) opts.push('ADMIN OPTION');
      if (typeof req.inheritOption === 'boolean') opts.push(`INHERIT ${req.inheritOption ? 'TRUE' : 'FALSE'}`);
      if (typeof req.setOption === 'boolean') opts.push(`SET ${req.setOption ? 'TRUE' : 'FALSE'}`);
    } else if (req.adminOption) {
      opts.push('ADMIN OPTION');
    }
    return [stmt(`GRANT ${roles} TO ${members}${opts.length ? ' WITH ' + opts.join(', ') : ''}`)];
  }
  if (req.action === 'revoke') {
    return [stmt(`REVOKE ${req.adminOption ? 'ADMIN OPTION FOR ' : ''}${roles} FROM ${members}${req.cascade ? ' CASCADE' : ''}`)];
  }
  throw new HttpError(400, 'action must be grant or revoke');
}

// ---------------------------------------------------------------- privileges

const NOT_SYSTEM_NS = (alias: string) =>
  `${alias}.nspname NOT IN ('pg_catalog', 'information_schema') AND ${alias}.nspname !~ '^pg_toast' AND ${alias}.nspname !~ '^pg_temp_'`;

/** Argument types of routine p, e.g. "bigint, text" (as in oid::regprocedure). */
const FN_ARGS = `COALESCE((SELECT string_agg(format_type(t.typ, NULL), ', ' ORDER BY t.ord)
              FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS t(typ, ord)), '')`;

/** "schema.fn(bigint, text)" — same as oid::regprocedure::text but always schema-qualified. */
const FN_SIGNATURE = `quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || ${FN_ARGS} || ')'`;

async function rolePrivileges(connId: string, db: string, role: string): Promise<PrivilegesResponse> {
  const [r] = await queryRows<{ oid: number }>(connId, db, `SELECT oid::int AS oid FROM pg_roles WHERE rolname = $1`, [role]);
  if (!r) throw new HttpError(404, `Role "${role}" does not exist`);
  const rows = await queryRows<{
    objectType: PrivilegeEntry['objectType']; schema: string | null; name: string; column: string | null;
    oid: number | null; signature: string | null; args: string | null; isOwner: boolean; privilege: string; grantable: boolean; grantor: string;
  }>(connId, db, `
    SELECT 'database' AS "objectType", NULL::text AS schema, d.datname::text AS name, NULL::text AS "column",
           NULL::int AS oid, NULL::text AS signature, NULL::text AS args, d.datdba = $1::oid AS "isOwner",
           a.privilege_type AS privilege, a.is_grantable AS grantable, pg_get_userbyid(a.grantor)::text AS grantor
      FROM pg_database d, aclexplode(d.datacl) a
     WHERE d.datname = current_database() AND a.grantee = $1::oid
    UNION ALL
    SELECT 'schema', NULL, n.nspname::text, NULL, NULL, NULL, NULL, n.nspowner = $1::oid,
           a.privilege_type, a.is_grantable, pg_get_userbyid(a.grantor)::text
      FROM pg_namespace n, aclexplode(n.nspacl) a
     WHERE a.grantee = $1::oid AND ${NOT_SYSTEM_NS('n')}
    UNION ALL
    SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
                          WHEN 'f' THEN 'foreign_table' ELSE 'table' END,
           n.nspname::text, c.relname::text, NULL, NULL, NULL, NULL, c.relowner = $1::oid,
           a.privilege_type, a.is_grantable, pg_get_userbyid(a.grantor)::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND a.grantee = $1::oid AND ${NOT_SYSTEM_NS('n')}
    UNION ALL
    SELECT 'column', n.nspname::text, c.relname::text, att.attname::text, NULL, NULL, NULL, false,
           a.privilege_type, a.is_grantable, pg_get_userbyid(a.grantor)::text
      FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
     WHERE att.attnum > 0 AND NOT att.attisdropped AND a.grantee = $1::oid AND ${NOT_SYSTEM_NS('n')}
    UNION ALL
    SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
           n.nspname::text, p.proname::text, NULL, p.oid::int, ${FN_SIGNATURE}, ${FN_ARGS}, p.proowner = $1::oid,
           a.privilege_type, a.is_grantable, pg_get_userbyid(a.grantor)::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
     WHERE a.grantee = $1::oid AND ${NOT_SYSTEM_NS('n')}
     ORDER BY 1, 2 NULLS FIRST, 3, 4 NULLS FIRST, 7, 9`, [r.oid]);

  const map = new Map<string, PrivilegeEntry>();
  for (const x of rows) {
    const key = [x.objectType, x.schema, x.name, x.column, x.oid].join('\u0000');
    let e = map.get(key);
    if (!e) {
      e = {
        objectType: x.objectType, schema: x.schema, name: x.name, column: x.column, oid: x.oid,
        signature: x.signature, args: x.args, isOwner: x.isOwner, privileges: [],
      };
      map.set(key, e);
    }
    e.privileges.push({ privilege: x.privilege, grantable: x.grantable, grantor: x.grantor });
  }
  return { role, database: db, entries: [...map.values()] };
}

async function grantTargets(connId: string, db: string, type: GrantTargetType): Promise<GrantTarget[]> {
  switch (type) {
    case 'database':
      return queryRows<GrantTarget>(connId, db, `
        SELECT NULL AS schema, datname AS name, datname AS label, 'database' AS kind
          FROM pg_database WHERE NOT datistemplate ORDER BY datname`);
    case 'schema':
    case 'all_tables':
    case 'all_sequences':
    case 'all_functions':
      return queryRows<GrantTarget>(connId, db, `
        SELECT NULL AS schema, n.nspname AS name, n.nspname AS label, 'schema' AS kind
          FROM pg_namespace n WHERE ${NOT_SYSTEM_NS('n')}
         ORDER BY n.nspname = 'public' DESC, n.nspname`);
    case 'table':
    case 'sequence': {
      const kinds = type === 'table' ? `('r','p','v','m','f')` : `('S')`;
      return queryRows<GrantTarget>(connId, db, `
        SELECT n.nspname AS schema, c.relname AS name, n.nspname || '.' || c.relname AS label,
               CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
                              WHEN 'f' THEN 'foreign_table' WHEN 'p' THEN 'partitioned_table' ELSE 'table' END AS kind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ${kinds} AND NOT c.relispartition AND ${NOT_SYSTEM_NS('n')}
         ORDER BY n.nspname, c.relname
         LIMIT 5000`);
    }
    case 'function':
      return queryRows<GrantTarget>(connId, db, `
        SELECT n.nspname AS schema, p.proname AS name, p.oid::int AS oid,
               n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS label,
               CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END AS kind
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          LEFT JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
         WHERE ${NOT_SYSTEM_NS('n')} AND d.objid IS NULL AND p.prokind IN ('f', 'p', 'a')
         ORDER BY n.nspname, p.proname, label
         LIMIT 5000`);
    default:
      throw new HttpError(400, `Unknown target type: ${type}`);
  }
}

function normalizePrivileges(type: GrantTargetType, privs: unknown, versionNum: number): string[] {
  if (!Array.isArray(privs) || privs.length === 0) throw new HttpError(400, 'Select at least one privilege');
  const allowed = PRIVILEGES_BY_TARGET[type];
  const out = new Set<string>();
  for (const raw of privs) {
    let p = String(raw).toUpperCase().trim();
    if (p === 'TEMP') p = 'TEMPORARY';
    if (p === 'ALL' || p === 'ALL PRIVILEGES') return ['ALL PRIVILEGES'];
    if (!allowed.includes(p)) throw new HttpError(400, `Privilege ${p} is not valid for ${type.replace('_', ' ')}`);
    const min = PRIVILEGE_MIN_VERSION[p];
    if (min && versionNum < min) throw new HttpError(400, `Privilege ${p} requires PostgreSQL ${min / 10000}+`);
    out.add(p);
  }
  return allowed.filter((p) => out.has(p));
}

async function buildPrivileges(connId: string, db: string, req: PrivilegeRequest): Promise<Stmt[]> {
  const ctx = await serverContext(connId);
  const q = await identQuoter(connId, db);
  const type = req.targetType;
  if (!(type in PRIVILEGES_BY_TARGET)) throw new HttpError(400, `Unknown target type: ${type}`);
  const privs = normalizePrivileges(type, req.privileges, ctx.versionNum);
  const grantees = nameList(req.grantees, 'grantee').map((g) => (g === 'PUBLIC' ? 'PUBLIC' : q(g))).join(', ');
  if (!Array.isArray(req.objects) || req.objects.length === 0) throw new HttpError(400, 'Select at least one object');
  const objs: GrantRef[] = req.objects;

  let privText = privs.join(', ');
  if (req.columns?.length) {
    if (type !== 'table') throw new HttpError(400, 'Column lists are only valid for tables');
    const colPrivs = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
    const cols = req.columns.map((c) => q(requireName(c, 'Column'))).join(', ');
    const list = privs[0] === 'ALL PRIVILEGES' ? ['ALL PRIVILEGES'] : privs;
    for (const p of list) if (p !== 'ALL PRIVILEGES' && !colPrivs.includes(p)) throw new HttpError(400, `${p} cannot be granted on columns`);
    privText = list.map((p) => `${p} (${cols})`).join(', ');
  }

  // Object clauses (ON ...). Functions may produce one clause per routine kind.
  const clauses: string[] = [];
  const qualifiedRef = (o: GrantRef) => {
    if (!o.schema) throw new HttpError(400, `Object "${o.name}" needs a schema`);
    return `${q(requireName(o.schema, 'Schema'))}.${q(requireName(o.name, 'Object name'))}`;
  };
  switch (type) {
    case 'database':
      clauses.push(`DATABASE ${objs.map((o) => q(requireName(o.name, 'Database'))).join(', ')}`);
      break;
    case 'schema':
      clauses.push(`SCHEMA ${objs.map((o) => q(requireName(o.name, 'Schema'))).join(', ')}`);
      break;
    case 'table':
      clauses.push(`TABLE ${objs.map(qualifiedRef).join(', ')}`);
      break;
    case 'sequence':
      clauses.push(`SEQUENCE ${objs.map(qualifiedRef).join(', ')}`);
      break;
    case 'all_tables':
    case 'all_sequences':
    case 'all_functions': {
      const what = type === 'all_tables' ? 'TABLES' : type === 'all_sequences' ? 'SEQUENCES' : 'FUNCTIONS';
      clauses.push(`ALL ${what} IN SCHEMA ${objs.map((o) => q(requireName(o.name, 'Schema'))).join(', ')}`);
      break;
    }
    case 'function': {
      const oids = objs.map((o) => Number(o.oid));
      if (oids.some((o) => !Number.isInteger(o) || o <= 0)) throw new HttpError(400, 'Functions must be identified by oid');
      const fns = await queryRows<{ oid: number; kind: string; sig: string }>(connId, db, `
        SELECT p.oid::int AS oid, p.prokind AS kind, ${FN_SIGNATURE} AS sig
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.oid = ANY($1::oid[])`, [oids]);
      if (fns.length !== new Set(oids).size) throw new HttpError(404, 'Some functions no longer exist — refresh and try again');
      const funcs = fns.filter((f) => f.kind !== 'p').map((f) => f.sig);
      const procs = fns.filter((f) => f.kind === 'p').map((f) => f.sig);
      if (funcs.length) clauses.push(`FUNCTION ${funcs.join(', ')}`);
      if (procs.length) clauses.push(`PROCEDURE ${procs.join(', ')}`);
      break;
    }
  }

  return clauses.map((on) => {
    if (req.action === 'grant') {
      return stmt(`GRANT ${privText} ON ${on} TO ${grantees}${req.grantOption ? ' WITH GRANT OPTION' : ''}`);
    }
    if (req.action === 'revoke') {
      return stmt(`REVOKE ${req.grantOption ? 'GRANT OPTION FOR ' : ''}${privText} ON ${on} FROM ${grantees}${req.cascade ? ' CASCADE' : ''}`);
    }
    throw new HttpError(400, 'action must be grant or revoke');
  });
}

// ---------------------------------------------------------------- drop

async function roleDependencies(connId: string, db: string, role: string): Promise<RoleDependencies> {
  const [r] = await queryRows<{ oid: number }>(connId, db, `SELECT oid::int AS oid FROM pg_roles WHERE rolname = $1`, [role]);
  if (!r) throw new HttpError(404, `Role "${role}" does not exist`);
  const perDatabase = await queryRows<RoleDependencySummary>(connId, db, `
    SELECT d.datname AS database,
           count(*) FILTER (WHERE s.deptype = 'o')::int AS owned,
           count(*) FILTER (WHERE s.deptype IN ('a', 'i'))::int AS privileges,
           count(*) FILTER (WHERE s.deptype = 'r')::int AS policies
      FROM pg_shdepend s
      LEFT JOIN pg_database d ON d.oid = s.dbid
     WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = $1::oid
     GROUP BY d.datname
     ORDER BY d.datname = current_database() DESC, d.datname NULLS FIRST`, [r.oid]);
  const objects = await queryRows<{ description: string; deptype: string }>(connId, db, `
    SELECT pg_describe_object(s.classid, s.objid, s.objsubid) AS description, s.deptype::text AS deptype
      FROM pg_shdepend s
     WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND s.refclassid = 'pg_authid'::regclass AND s.refobjid = $1::oid
     ORDER BY s.deptype <> 'o', 1
     LIMIT 500`, [r.oid]);
  const [{ total }] = await queryRows<{ total: number }>(connId, db, `
    SELECT count(*)::int AS total FROM pg_shdepend s
     WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND s.refclassid = 'pg_authid'::regclass AND s.refobjid = $1::oid`, [r.oid]);
  const ownedDatabases = (await queryRows<{ name: string }>(connId, db,
    `SELECT datname AS name FROM pg_database WHERE datdba = $1::oid ORDER BY 1`, [r.oid])).map((x) => x.name);
  const kindOf = (t: string): RoleDependencyObject['kind'] =>
    t === 'o' ? 'owner' : t === 'a' || t === 'i' ? 'privilege' : t === 'r' ? 'policy' : 'other';
  return {
    role,
    database: db,
    objects: objects.map((o) => ({ description: o.description, kind: kindOf(o.deptype) })),
    totalInDatabase: total,
    perDatabase,
    ownedDatabases,
  };
}

async function buildDrop(connId: string, db: string, role: string, req: DropRoleRequest): Promise<Stmt[]> {
  requireName(role);
  const q = await identQuoter(connId, db);
  const out: Stmt[] = [];
  if (req.reassignTo) out.push(stmt(`REASSIGN OWNED BY ${q(role)} TO ${q(requireName(req.reassignTo, 'New owner'))}`));
  if (req.dropOwned) out.push(stmt(`DROP OWNED BY ${q(role)}${req.cascade ? ' CASCADE' : ''}`));
  if (req.dropRole) out.push(stmt(`DROP ROLE ${q(role)}`));
  if (!out.length) throw new HttpError(400, 'Nothing to do — choose at least one action');
  return out;
}

// ---------------------------------------------------------------- routes

export default async function rolesRoutes(app: FastifyInstance) {
  type C = { connId: string };
  type D = { connId: string; db: string };

  app.get<{ Params: C }>('/api/c/:connId/roles', async (req) => listRoles(req.params.connId));

  app.post<{ Params: C; Body: RoleMutationRequest }>('/api/c/:connId/roles', async (req): Promise<SqlResult> => {
    const { connId } = req.params;
    const spec = req.body?.spec;
    if (!spec) throw new HttpError(400, 'Missing role spec');
    const pw = await passwordCtx(connId);
    try {
      const stmts = await buildCreate(connId, spec, pw);
      return await execute(connId, undefined, stmts, req.body.dryRun, pw.secrets);
    } catch (e) {
      throw scrub(e, [...pw.secrets, spec.password ?? '']);
    }
  });

  app.put<{ Params: C & { name: string }; Body: RoleMutationRequest }>('/api/c/:connId/roles/:name', async (req): Promise<SqlResult> => {
    const { connId, name } = req.params;
    const spec = req.body?.spec;
    if (!spec) throw new HttpError(400, 'Missing role spec');
    const pw = await passwordCtx(connId);
    try {
      const stmts = await buildAlter(connId, name, spec, pw);
      return await execute(connId, undefined, stmts, req.body.dryRun, pw.secrets);
    } catch (e) {
      throw scrub(e, [...pw.secrets, spec.password ?? '']);
    }
  });

  app.post<{ Params: C; Body: MembershipRequest }>('/api/c/:connId/roles/membership', async (req): Promise<SqlResult> => {
    const { connId } = req.params;
    const ctx = await serverContext(connId);
    const stmts = await buildMembership(connId, req.body ?? ({} as MembershipRequest), ctx.versionNum);
    return execute(connId, undefined, stmts, req.body.dryRun);
  });

  app.get<{ Params: D; Querystring: { type?: GrantTargetType } }>('/api/c/:connId/db/:db/roles/targets', async (req) => {
    return grantTargets(req.params.connId, req.params.db, req.query.type ?? 'table');
  });

  app.post<{ Params: D; Body: PrivilegeRequest }>('/api/c/:connId/db/:db/roles/privileges', async (req): Promise<SqlResult> => {
    const { connId, db } = req.params;
    if (!req.body) throw new HttpError(400, 'Missing request body');
    const stmts = await buildPrivileges(connId, db, req.body);
    return execute(connId, db, stmts, req.body.dryRun);
  });

  app.get<{ Params: D & { name: string } }>('/api/c/:connId/db/:db/roles/:name/privileges', async (req) => {
    return rolePrivileges(req.params.connId, req.params.db, req.params.name);
  });

  app.get<{ Params: D & { name: string } }>('/api/c/:connId/db/:db/roles/:name/dependencies', async (req) => {
    return roleDependencies(req.params.connId, req.params.db, req.params.name);
  });

  app.post<{ Params: D & { name: string }; Body: DropRoleRequest }>('/api/c/:connId/db/:db/roles/:name/drop', async (req): Promise<SqlResult> => {
    const { connId, db, name } = req.params;
    const stmts = await buildDrop(connId, db, name, req.body ?? {});
    return execute(connId, db, stmts, req.body?.dryRun);
  });
}
