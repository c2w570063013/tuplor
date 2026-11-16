import {
  Activity, Archive, ClipboardCopy, Code2, Copy, Database, Eraser, Eye, FileCode2, FilePlus2, FolderPlus, FunctionSquare, Network,
  PackageMinus, PackagePlus, Pencil, Play, RefreshCw, RotateCcw, Search, Sparkles, Table2, TableProperties, Trash2, Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ExtensionInfo, FunctionDetails } from '@shared/schema';
import type { DbObject, DbObjectKind } from '@shared/types';
import { SqlBlock } from '@/components/SqlBlock';
import { Checkbox, Input, toast, type MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { invalidateDb } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { confirm, prompt } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { errorText, fetchTableDdl, runDdl, schemaApi, toScript } from '../structure/api';
import {
  alterKeyword, deleteTemplate, DROP_KEYWORD, fq, insertTemplate, objectRef, qi, selectTemplate, updateTemplate, type DropKind,
} from '../structure/sqlgen';

/**
 * Actions & context menus for explorer nodes. Also used by the structure / object tabs.
 */

export const RELATION_KINDS: DbObjectKind[] = ['table', 'partitioned_table', 'view', 'materialized_view', 'foreign_table'];
export const TABLE_KINDS: DbObjectKind[] = ['table', 'partitioned_table', 'foreign_table'];
export const isRelation = (k: DbObjectKind) => RELATION_KINDS.includes(k);
export const isTableKind = (k: DbObjectKind) => TABLE_KINDS.includes(k);

const ws = () => useWorkspace.getState();

// ------------------------------------------------------------------ open helpers

export function openData(connId: string, db: string, o: Pick<DbObject, 'schema' | 'name' | 'kind'>, preview = false) {
  ws().openTab({
    kind: 'table-data', title: o.name, connId, database: db, preview,
    key: `data:${connId}:${db}:${o.schema}.${o.name}`,
    params: { schema: o.schema, table: o.name, objectKind: o.kind },
  });
}

export function openStructure(connId: string, db: string, schema: string, table: string, objectKind?: DbObjectKind, section?: string, preview = false) {
  ws().openTab({
    kind: 'structure', title: table, connId, database: db, preview,
    key: `struct:${connId}:${db}:${schema}.${table}`,
    params: { schema, table, objectKind, ...(section ? { section } : {}) },
  });
}

export function openObjectTab(connId: string, db: string, o: Pick<DbObject, 'schema' | 'name' | 'kind' | 'oid' | 'args'>, preview = false) {
  ws().openTab({
    kind: 'object', title: o.name, connId, database: db, preview,
    key: `obj:${connId}:${db}:${o.kind}:${o.oid}`,
    params: { schema: o.schema, name: o.name, objectKind: o.kind, oid: o.oid, args: o.args },
  });
}

/** Open an object by schema/name when only the name is known (e.g. a trigger function link). */
export async function openObjectByName(connId: string, db: string, schema: string, name: string, kind: DbObjectKind) {
  if (isTableKind(kind)) return openStructure(connId, db, schema, name, kind);
  try {
    const oid = await schemaApi.resolve(connId, db, schema, name, kind);
    openObjectTab(connId, db, { schema, name, kind, oid });
  } catch (e) {
    toast.error(errorText(e));
  }
}

export function openCreateTable(connId: string, db: string, schema: string) {
  ws().openTab({ kind: 'create-table', title: 'New table', connId, database: db, params: { schema } });
}

export function newQuery(connId: string, db: string, sql: string, title?: string) {
  ws().newQuery({ connId, database: db, sql, title });
}

function copy(text: string, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast.success(what, { duration: 1500 }));
}

// ------------------------------------------------------------------ option dialogs

interface Opt { key: string; label: string; hint?: string; default?: boolean }

function OptionsBody({ description, options, build, onChange }: {
  description?: string; options: Opt[]; build: (o: Record<string, boolean>) => string[]; onChange: (o: Record<string, boolean>) => void;
}) {
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(options.map((o) => [o.key, !!o.default])));
  useEffect(() => onChange(state), [state, onChange]);
  return (
    <div className="flex flex-col gap-3">
      {description && <div>{description}</div>}
      {options.length > 0 && (
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <label key={o.key} className="flex cursor-pointer items-start gap-2 text-fg">
              <Checkbox className="mt-0.5" checked={!!state[o.key]} onCheckedChange={(v) => setState((s) => ({ ...s, [o.key]: v }))} />
              <span>
                <span className="text-[12.5px]">{o.label}</span>
                {o.hint && <span className="block text-[11.5px] text-subtle">{o.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      <SqlBlock sql={toScript(build(state))} className="max-h-48" />
    </div>
  );
}

/** confirm() with checkbox options and a live SQL preview; returns the statements or null. */
export async function confirmWithOptions(o: {
  title: string; description?: string; options: Opt[]; build: (opts: Record<string, boolean>) => string[]; danger?: boolean; confirmLabel?: string;
}): Promise<string[] | null> {
  let state: Record<string, boolean> = Object.fromEntries(o.options.map((x) => [x.key, !!x.default]));
  const ok = await confirm({
    title: o.title,
    danger: o.danger,
    confirmLabel: o.confirmLabel,
    message: <OptionsBody description={o.description} options={o.options} build={o.build} onChange={(s) => { state = s; }} />,
  });
  return ok ? o.build(state) : null;
}

const CASCADE: Opt = { key: 'cascade', label: 'Cascade', hint: 'Also drop objects that depend on it' };

export async function dropObject(connId: string, db: string, kind: DropKind, schema: string, name: string, args?: string, after?: () => void) {
  const ref = objectRef(kind, schema, name, args);
  const isSchema = kind === 'schema';
  const label = isSchema || kind === 'extension' ? name : `${schema}.${name}`;
  const stmts = await confirmWithOptions({
    title: `Drop ${DROP_KEYWORD[kind].toLowerCase()} “${label}”?`,
    description: isSchema ? 'Every object in the schema must be dropped first, or use Cascade.' : 'This cannot be undone.',
    options: [CASCADE],
    danger: true,
    confirmLabel: 'Drop',
    build: (o) => [`DROP ${DROP_KEYWORD[kind]} ${ref}${o.cascade ? ' CASCADE' : ''}`],
  });
  if (!stmts) return false;
  const ok = await runDdl({ connId, db, title: '', statements: stmts, skipConfirm: true, success: `Dropped ${label}` });
  if (ok) {
    closeTabsFor(connId, db, schema, name, kind);
    after?.();
  }
  return ok;
}

/** Close tabs that show a dropped object. */
function closeTabsFor(connId: string, db: string, schema: string, name: string, kind: string) {
  const { tabs, closeTab } = ws();
  for (const t of tabs) {
    if (t.connId !== connId || t.database !== db) continue;
    const p = t.params;
    if (kind === 'schema' ? p.schema === name && ['structure', 'table-data', 'object', 'create-table'].includes(t.kind)
      : p.schema === schema && (p.table === name || p.name === name) && ['structure', 'table-data', 'object'].includes(t.kind)) {
      closeTab(t.id);
    }
  }
}

export async function truncateTable(connId: string, db: string, schema: string, table: string) {
  const stmts = await confirmWithOptions({
    title: `Truncate “${schema}.${table}”?`,
    description: 'All rows will be permanently deleted.',
    options: [
      { key: 'restart', label: 'Restart identity', hint: 'Reset sequences owned by the table columns' },
      { key: 'cascade', label: 'Cascade', hint: 'Also truncate tables with foreign keys to this table' },
    ],
    danger: true,
    confirmLabel: 'Truncate',
    build: (o) => [`TRUNCATE TABLE ${fq(schema, table)}${o.restart ? ' RESTART IDENTITY' : ''}${o.cascade ? ' CASCADE' : ''}`],
  });
  if (!stmts) return;
  await runDdl({ connId, db, title: '', statements: stmts, skipConfirm: true, success: `Truncated ${schema}.${table}` });
}

export async function renameObject(connId: string, db: string, kind: string, schema: string, name: string, args?: string) {
  const next = await prompt({ title: `Rename ${alterKeyword(kind).toLowerCase()}`, defaultValue: name, confirmLabel: 'Rename' });
  if (!next || next === name) return;
  const ok = await runDdl({
    connId, db, title: '', skipConfirm: true,
    statements: [`ALTER ${alterKeyword(kind)} ${objectRef(kind, schema, name, args)} RENAME TO ${qi(next)}`],
    success: `Renamed to ${next}`,
  });
  if (ok) closeTabsFor(connId, db, schema, name, kind);
}

export async function maintenance(connId: string, db: string, schema: string, table: string, op: 'VACUUM' | 'VACUUM ANALYZE' | 'VACUUM FULL' | 'ANALYZE' | 'REINDEX') {
  const target = fq(schema, table);
  const sql = op === 'REINDEX' ? `REINDEX TABLE ${target}` : `${op} ${target}`;
  await runDdl({
    connId, db, title: op === 'VACUUM FULL' ? 'VACUUM FULL (takes an exclusive lock)' : `Run ${op.toLowerCase()}`,
    statements: [sql], transaction: false, confirmLabel: 'Run', danger: op === 'VACUUM FULL',
    message: op === 'VACUUM FULL' ? 'Rewrites the whole table. Reads and writes are blocked until it completes.' : undefined,
    success: `${op} ${schema}.${table} completed`,
  });
}

// ------------------------------------------------------------------ SQL generation into editor

export async function generateSql(connId: string, db: string, o: Pick<DbObject, 'schema' | 'name' | 'kind' | 'oid'>, what: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE') {
  try {
    let sql: string;
    if (what === 'CREATE') {
      sql = isRelation(o.kind) || o.kind === 'sequence'
        ? await fetchTableDdl(connId, db, o.schema, o.name)
        : (await schemaApi.object(connId, db, o.kind, o.oid)).ddl;
    } else {
      const cols = await api.columns(connId, db, o.schema, o.name);
      sql = what === 'SELECT' ? selectTemplate(o.schema, o.name, cols)
        : what === 'INSERT' ? insertTemplate(o.schema, o.name, cols)
        : what === 'UPDATE' ? updateTemplate(o.schema, o.name, cols)
        : deleteTemplate(o.schema, o.name, cols);
    }
    newQuery(connId, db, sql, `${what.charAt(0) + what.slice(1).toLowerCase()} ${o.name}`);
  } catch (e) {
    toast.error(errorText(e));
  }
}

function callTemplate(f: FunctionDetails): string {
  const inputs = f.params.filter((p) => p.mode === 'IN' || p.mode === 'INOUT' || p.mode === 'VARIADIC');
  const args = inputs.map((p) => (p.name ? `${qi(p.name)} => NULL${p.default ? ` /* default ${p.default} */` : ''} /* ${p.type} */` : `NULL /* ${p.type} */`));
  const call = `${fq(f.schema, f.name)}(${args.length ? '\n    ' + args.join(',\n    ') + '\n' : ''})`;
  if (f.kind === 'procedure') return `CALL ${call};\n`;
  return f.result?.startsWith('TABLE') || f.rows != null ? `SELECT *\n  FROM ${call};\n` : `SELECT ${call};\n`;
}

export async function routineToEditor(connId: string, db: string, o: Pick<DbObject, 'schema' | 'name' | 'kind' | 'oid'>, mode: 'call' | 'edit') {
  try {
    const f = (await schemaApi.object(connId, db, o.kind, o.oid)) as FunctionDetails;
    if (mode === 'call') newQuery(connId, db, callTemplate(f), `Run ${f.name}`);
    else newQuery(connId, db, (f.definition ?? f.ddl).trimEnd() + (f.definition ? ';\n' : '\n'), `Edit ${f.name}`);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ------------------------------------------------------------------ create helpers

const VIEW_TEMPLATE = (schema: string) => `CREATE VIEW ${qi(schema)}.new_view AS\nSELECT\n  \nFROM ;\n`;
const FUNCTION_TEMPLATE = (schema: string) =>
  `CREATE OR REPLACE FUNCTION ${qi(schema)}.new_function(p_id bigint)\nRETURNS text\nLANGUAGE plpgsql\nSTABLE\nAS $$\nBEGIN\n  RETURN p_id::text;\nEND;\n$$;\n`;
const PROCEDURE_TEMPLATE = (schema: string) =>
  `CREATE OR REPLACE PROCEDURE ${qi(schema)}.new_procedure(p_id bigint)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- …\nEND;\n$$;\n`;
const MATVIEW_TEMPLATE = (schema: string) => `CREATE MATERIALIZED VIEW ${qi(schema)}.new_matview AS\nSELECT\n  \nFROM \nWITH DATA;\n`;
const ENUM_TEMPLATE = (schema: string) => `CREATE TYPE ${qi(schema)}.new_enum AS ENUM ('a', 'b', 'c');\n`;
const SEQUENCE_TEMPLATE = (schema: string) => `CREATE SEQUENCE ${qi(schema)}.new_seq\n  AS bigint\n  START WITH 1\n  INCREMENT BY 1;\n`;

export async function createSchema(connId: string, db: string) {
  const name = await prompt({ title: 'Create schema', placeholder: 'schema_name', confirmLabel: 'Create' });
  if (!name?.trim()) return;
  await runDdl({ connId, db, title: 'Create schema', statements: [`CREATE SCHEMA ${qi(name.trim())}`], success: `Schema ${name.trim()} created`, confirmLabel: 'Create' });
}

/** Database statements must run outside a transaction and not on the target database. */
function adminDb(connId: string, target?: string) {
  const conn = useConnections.getState().get(connId);
  const def = conn?.database ?? 'postgres';
  if (target && def === target) return target === 'postgres' ? 'template1' : 'postgres';
  return def;
}

export async function createDatabase(connId: string) {
  const name = await prompt({ title: 'Create database', placeholder: 'database_name', confirmLabel: 'Continue' });
  if (!name?.trim()) return;
  await runDdl({
    connId, db: adminDb(connId), title: 'Create database', statements: [`CREATE DATABASE ${qi(name.trim())}`],
    transaction: false, success: `Database ${name.trim()} created`, confirmLabel: 'Create', refreshConnection: true,
  });
}

export async function dropDatabase(connId: string, db: string) {
  const stmts = await confirmWithOptions({
    title: `Drop database “${db}”?`,
    description: 'The database and everything in it will be permanently deleted.',
    options: [{ key: 'force', label: 'Force', hint: 'Terminate other sessions connected to this database' }],
    danger: true,
    confirmLabel: 'Drop database',
    build: (o) => [`DROP DATABASE ${qi(db)}${o.force ? ' WITH (FORCE)' : ''}`],
  });
  if (!stmts) return;
  const ok = await runDdl({ connId, db: adminDb(connId, db), title: '', statements: stmts, skipConfirm: true, transaction: false, success: `Dropped database ${db}`, refreshConnection: true });
  if (ok) {
    const { tabs, closeTab, activeDb, activeConnId, setActiveDb } = ws();
    tabs.filter((t) => t.connId === connId && t.database === db).forEach((t) => closeTab(t.id));
    if (activeConnId === connId && activeDb === db) setActiveDb(connId, adminDb(connId));
  }
}

function ExtensionPicker({ connId, db, onPick }: { connId: string; db: string; onPick: (e: ExtensionInfo | null) => void }) {
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    schemaApi.extensions(connId, db).then((l) => setList(l.filter((e) => !e.installedVersion)), (e) => setErr(errorText(e)));
  }, [connId, db]);
  const shown = useMemo(() => (list ?? []).filter((e) => !q || e.name.includes(q.toLowerCase()) || e.comment?.toLowerCase().includes(q.toLowerCase())), [list, q]);
  return (
    <div className="flex flex-col gap-2">
      <Input size="sm" autoFocus icon={<Search size={12} />} placeholder="Search extensions…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="h-64 overflow-auto rounded-md border border-border">
        {err && <div className="p-3 text-xs text-danger">{err}</div>}
        {!list && !err && <div className="p-3 text-xs text-muted">Loading…</div>}
        {list && !shown.length && <div className="p-3 text-xs text-muted">No available extensions match.</div>}
        {shown.map((e) => (
          <button
            key={e.name}
            onClick={() => { setSel(e.name); onPick(e); }}
            className={cn('flex w-full flex-col items-start px-2.5 py-1.5 text-left hover:bg-hover', sel === e.name && 'bg-accent-soft')}
          >
            <span className="flex w-full items-center gap-2 text-[12.5px] font-medium text-fg">{e.name}<span className="ml-auto text-[11px] font-normal text-subtle">{e.defaultVersion}</span></span>
            <span className="line-clamp-1 text-[11.5px] text-subtle">{e.comment}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export async function installExtension(connId: string, db: string) {
  let picked: ExtensionInfo | null = null;
  const ok = await confirm({ title: 'Install extension', confirmLabel: 'Continue', message: <ExtensionPicker connId={connId} db={db} onPick={(e) => { picked = e; }} /> });
  const ext = picked as ExtensionInfo | null;
  if (!ok || !ext) return;
  await runDdl({
    connId, db, title: `Install ${ext.name}`, statements: [`CREATE EXTENSION IF NOT EXISTS ${qi(ext.name)}`],
    success: `Extension ${ext.name} installed`, confirmLabel: 'Install',
  });
}

// ------------------------------------------------------------------ menus

const I = 14;

export function generateSubmenu(connId: string, db: string, o: DbObject): MenuItem {
  const rel = isRelation(o.kind);
  const writable = isTableKind(o.kind);
  return {
    label: 'Generate SQL', icon: <Code2 size={I} />,
    items: [
      ...(rel ? [{ label: 'SELECT', onSelect: () => generateSql(connId, db, o, 'SELECT') }] : []),
      ...(writable ? [
        { label: 'INSERT', onSelect: () => generateSql(connId, db, o, 'INSERT') },
        { label: 'UPDATE', onSelect: () => generateSql(connId, db, o, 'UPDATE') },
        { label: 'DELETE', onSelect: () => generateSql(connId, db, o, 'DELETE') },
      ] : []),
      ...(rel ? ['separator' as const] : []),
      { label: 'CREATE (DDL)', onSelect: () => generateSql(connId, db, o, 'CREATE') },
    ],
  };
}

export function objectMenu(connId: string, db: string, o: DbObject): MenuItem[] {
  const items: MenuItem[] = [];
  const kind = o.kind;
  if (isTableKind(kind)) {
    items.push(
      { label: 'Open data', icon: <Table2 size={I} />, onSelect: () => openData(connId, db, o) },
      { label: 'Structure', icon: <TableProperties size={I} />, onSelect: () => openStructure(connId, db, o.schema, o.name, kind) },
      { label: 'Query (SELECT)', icon: <FileCode2 size={I} />, onSelect: () => generateSql(connId, db, o, 'SELECT') },
    );
  } else if (kind === 'view' || kind === 'materialized_view') {
    items.push(
      { label: 'Open data', icon: <Table2 size={I} />, onSelect: () => openData(connId, db, o) },
      { label: 'Definition', icon: <Eye size={I} />, onSelect: () => openObjectTab(connId, db, o) },
      { label: 'Query (SELECT)', icon: <FileCode2 size={I} />, onSelect: () => generateSql(connId, db, o, 'SELECT') },
    );
  } else if (kind === 'function' || kind === 'procedure' || kind === 'aggregate') {
    items.push(
      { label: 'Open', icon: <FunctionSquare size={I} />, onSelect: () => openObjectTab(connId, db, o) },
      ...(kind !== 'aggregate' ? [
        { label: kind === 'procedure' ? 'Call in editor' : 'Execute in editor', icon: <Play size={I} />, onSelect: () => routineToEditor(connId, db, o, 'call') },
        { label: 'Edit in SQL editor', icon: <Pencil size={I} />, onSelect: () => routineToEditor(connId, db, o, 'edit') },
      ] : []),
    );
  } else {
    items.push({ label: 'Open', icon: <Eye size={I} />, onSelect: () => openObjectTab(connId, db, o) });
    if (kind === 'sequence') {
      items.push({
        label: 'Restart sequence…', icon: <RotateCcw size={I} />,
        onSelect: () => runDdl({ connId, db, title: 'Restart sequence', statements: [`ALTER SEQUENCE ${fq(o.schema, o.name)} RESTART`], success: `${o.name} restarted`, danger: true, confirmLabel: 'Restart' }),
      });
    }
  }
  items.push(
    'separator',
    { label: 'Copy name', icon: <Copy size={I} />, onSelect: () => copy(o.name, `Copied ${o.name}`) },
    { label: 'Copy qualified name', icon: <ClipboardCopy size={I} />, onSelect: () => copy(objectRef(kind, o.schema, o.name, o.args), 'Copied qualified name') },
    generateSubmenu(connId, db, o),
  );
  if (isTableKind(kind) || kind === 'materialized_view') {
    const maint: MenuItem[] = kind === 'materialized_view'
      ? [
          { label: 'Refresh materialized view', icon: <RefreshCw size={I} />, onSelect: () => runDdl({ connId, db, title: 'Refresh materialized view', statements: [`REFRESH MATERIALIZED VIEW ${fq(o.schema, o.name)}`], success: `${o.name} refreshed`, confirmLabel: 'Refresh' }) },
          { label: 'Refresh concurrently', onSelect: () => runDdl({ connId, db, title: 'Refresh materialized view concurrently', message: 'Requires a unique index on the materialized view.', statements: [`REFRESH MATERIALIZED VIEW CONCURRENTLY ${fq(o.schema, o.name)}`], transaction: false, success: `${o.name} refreshed`, confirmLabel: 'Refresh' }) },
          'separator',
          { label: 'ANALYZE', onSelect: () => maintenance(connId, db, o.schema, o.name, 'ANALYZE') },
          { label: 'REINDEX', onSelect: () => maintenance(connId, db, o.schema, o.name, 'REINDEX') },
        ]
      : [
          { label: 'VACUUM', onSelect: () => maintenance(connId, db, o.schema, o.name, 'VACUUM') },
          { label: 'VACUUM ANALYZE', onSelect: () => maintenance(connId, db, o.schema, o.name, 'VACUUM ANALYZE') },
          { label: 'VACUUM FULL', onSelect: () => maintenance(connId, db, o.schema, o.name, 'VACUUM FULL') },
          { label: 'ANALYZE', onSelect: () => maintenance(connId, db, o.schema, o.name, 'ANALYZE') },
          { label: 'REINDEX', onSelect: () => maintenance(connId, db, o.schema, o.name, 'REINDEX') },
        ];
    items.push({ label: 'Maintenance', icon: <Wrench size={I} />, items: maint });
  }
  items.push('separator', { label: 'Rename…', icon: <Pencil size={I} />, onSelect: () => renameObject(connId, db, kind, o.schema, o.name, o.args) });
  if (kind === 'table' || kind === 'partitioned_table') {
    items.push({ label: 'Truncate…', icon: <Eraser size={I} />, danger: true, onSelect: () => truncateTable(connId, db, o.schema, o.name) });
  }
  items.push({ label: `Drop ${kind.replace(/_/g, ' ')}…`, icon: <Trash2 size={I} />, danger: true, onSelect: () => dropObject(connId, db, kind as DropKind, o.schema, o.name, o.args) });
  return items;
}

export function createSubmenu(connId: string, db: string, schema: string): MenuItem {
  return {
    label: 'Create', icon: <FilePlus2 size={I} />,
    items: [
      { label: 'Table…', icon: <Table2 size={I} />, onSelect: () => openCreateTable(connId, db, schema) },
      { label: 'View', onSelect: () => newQuery(connId, db, VIEW_TEMPLATE(schema), 'New view') },
      { label: 'Materialized view', onSelect: () => newQuery(connId, db, MATVIEW_TEMPLATE(schema), 'New materialized view') },
      { label: 'Function', onSelect: () => newQuery(connId, db, FUNCTION_TEMPLATE(schema), 'New function') },
      { label: 'Procedure', onSelect: () => newQuery(connId, db, PROCEDURE_TEMPLATE(schema), 'New procedure') },
      { label: 'Enum type', onSelect: () => newQuery(connId, db, ENUM_TEMPLATE(schema), 'New enum') },
      { label: 'Sequence', onSelect: () => newQuery(connId, db, SEQUENCE_TEMPLATE(schema), 'New sequence') },
    ],
  };
}

export function schemaMenu(connId: string, db: string, schema: string): MenuItem[] {
  return [
    { label: 'New query', icon: <FileCode2 size={I} />, onSelect: () => newQuery(connId, db, `SET search_path TO ${qi(schema)}, public;\n\n`) },
    { label: 'New table…', icon: <Table2 size={I} />, onSelect: () => openCreateTable(connId, db, schema) },
    createSubmenu(connId, db, schema),
    { label: 'ER diagram', icon: <Network size={I} />, onSelect: () => ws().openTab({ kind: 'erd', title: `ERD · ${schema}`, connId, database: db, key: `erd:${connId}:${db}:${schema}`, params: { schema } }) },
    'separator',
    { label: 'Copy name', icon: <Copy size={I} />, onSelect: () => copy(schema, `Copied ${schema}`) },
    { label: 'Refresh', icon: <RefreshCw size={I} />, onSelect: () => invalidateDb(connId, db) },
    'separator',
    { label: 'Rename schema…', icon: <Pencil size={I} />, onSelect: () => renameObject(connId, db, 'schema', schema, schema) },
    { label: 'Drop schema…', icon: <Trash2 size={I} />, danger: true, onSelect: () => dropObject(connId, db, 'schema', schema, schema) },
  ];
}

export function databaseMenu(connId: string, db: string): MenuItem[] {
  return [
    { label: 'New query', icon: <FileCode2 size={I} />, onSelect: () => newQuery(connId, db, '') },
    { label: 'Create schema…', icon: <FolderPlus size={I} />, onSelect: () => createSchema(connId, db) },
    { label: 'Install extension…', icon: <PackagePlus size={I} />, onSelect: () => installExtension(connId, db) },
    'separator',
    { label: 'Server dashboard', icon: <Activity size={I} />, onSelect: () => ws().openTab({ kind: 'dashboard', title: 'Dashboard', connId, database: db, key: `dash:${connId}` }) },
    { label: 'Backup…', icon: <Archive size={I} />, onSelect: () => ws().openTab({ kind: 'backup', title: `Backup · ${db}`, connId, database: db, key: `backup:${connId}:${db}`, params: { mode: 'backup' } }) },
    'separator',
    { label: 'Copy name', icon: <Copy size={I} />, onSelect: () => copy(db, `Copied ${db}`) },
    { label: 'Refresh', icon: <RefreshCw size={I} />, onSelect: () => { invalidateDb(connId, db); useConnections.getState().refresh(connId).catch(() => {}); } },
    'separator',
    { label: 'Create database…', icon: <Database size={I} />, onSelect: () => createDatabase(connId) },
    { label: 'Drop database…', icon: <Trash2 size={I} />, danger: true, onSelect: () => dropDatabase(connId, db) },
  ];
}

export function extensionMenu(connId: string, db: string, e: ExtensionInfo): MenuItem[] {
  return [
    { label: 'Copy name', icon: <Copy size={I} />, onSelect: () => copy(e.name, `Copied ${e.name}`) },
    ...(e.defaultVersion && e.installedVersion && e.defaultVersion !== e.installedVersion ? [{
      label: `Update to ${e.defaultVersion}`, icon: <Sparkles size={I} />,
      onSelect: () => runDdl({ connId, db, title: `Update ${e.name}`, statements: [`ALTER EXTENSION ${qi(e.name)} UPDATE`], success: `${e.name} updated`, confirmLabel: 'Update' }),
    }] : []),
    'separator',
    { label: 'Remove extension…', icon: <PackageMinus size={I} />, danger: true, onSelect: () => dropObject(connId, db, 'extension', e.schema ?? '', e.name) },
  ];
}

export function extensionsFolderMenu(connId: string, db: string): MenuItem[] {
  return [
    { label: 'Install extension…', icon: <PackagePlus size={I} />, onSelect: () => installExtension(connId, db) },
    { label: 'Refresh', icon: <RefreshCw size={I} />, onSelect: () => invalidateDb(connId, db) },
  ];
}

export function schemasFolderMenu(connId: string, db: string): MenuItem[] {
  return [
    { label: 'Create schema…', icon: <FolderPlus size={I} />, onSelect: () => createSchema(connId, db) },
    { label: 'Refresh', icon: <RefreshCw size={I} />, onSelect: () => invalidateDb(connId, db) },
  ];
}

