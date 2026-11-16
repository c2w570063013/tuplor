import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertCircle, Ban, ChevronRight, ChevronsDownUp, Columns3, Database, Eye, FileCode2, Fingerprint, Folder, FolderTree,
  FunctionSquare, Hash, KeyRound, Layers, Link2, ListOrdered, Loader2, Pencil, Plug, Plus, Puzzle, RefreshCw, Search, Shapes, ShieldCheck,
  Table2, TableCellsSplit, TableProperties, Trash2, Unplug, X, Zap,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ConstraintDetail, ExtensionInfo, IndexDetail, TriggerDetail } from '@shared/schema';
import type { ConnectionConfig, DbObject, DbObjectKind } from '@shared/types';
import { ContextMenu, IconButton, Input, toast, type MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { confirm } from '@/stores/dialogs';
import { useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { useConnectionDialog } from '../connections/ConnectionDialog';
import { errorText, runDdl, schemaApi, schemaKeys, useTableDetails } from '../structure/api';
import { fq, qi } from '../structure/sqlgen';
import {
  createDatabase, databaseMenu, dropObject, extensionMenu, extensionsFolderMenu, isRelation, isTableKind, objectMenu, openData,
  openObjectTab, openStructure, schemaMenu, schemasFolderMenu,
} from './actions';
import { useExpanded, useTree } from './treeStore';

/**
 * Sidebar object explorer:
 *   connection → database → Schemas → schema → object groups → objects → (columns / indexes / constraints / triggers / partitions)
 *                         → Extensions
 * Keyboard: ↑ ↓ move, → expand / first child, ← collapse / parent, Enter open, Home / End.
 */

const GROUPS: { label: string; kinds: DbObjectKind[]; icon: ReactNode }[] = [
  { label: 'Tables', kinds: ['table', 'partitioned_table'], icon: <Table2 size={14} className="text-accent" /> },
  { label: 'Views', kinds: ['view'], icon: <Eye size={14} className="text-info" /> },
  { label: 'Materialized Views', kinds: ['materialized_view'], icon: <Layers size={14} className="text-info" /> },
  { label: 'Foreign Tables', kinds: ['foreign_table'], icon: <Table2 size={14} className="text-muted" /> },
  { label: 'Functions', kinds: ['function', 'procedure', 'aggregate'], icon: <FunctionSquare size={14} className="text-syntax-keyword" /> },
  { label: 'Sequences', kinds: ['sequence'], icon: <Hash size={14} className="text-syntax-number" /> },
  { label: 'Types', kinds: ['type', 'enum', 'domain'], icon: <Shapes size={14} className="text-success" /> },
];

export function objectIcon(kind: DbObjectKind): ReactNode {
  switch (kind) {
    case 'partitioned_table': return <TableCellsSplit size={14} className="text-accent" />;
    case 'index': return <ListOrdered size={14} className="text-syntax-number" />;
    case 'trigger': return <Zap size={14} className="text-warning" />;
    case 'extension': return <Puzzle size={14} className="text-success" />;
    case 'schema': return <FolderTree size={14} className="text-muted" />;
  }
  return GROUPS.find((g) => g.kinds.includes(kind))?.icon ?? <Table2 size={14} />;
}

/** Open an object from the explorer / command palette: relations → data, others → details tab. */
export function openObject(connId: string, db: string, o: DbObject, preview: boolean) {
  if (isRelation(o.kind)) openData(connId, db, o, preview);
  else openObjectTab(connId, db, o, preview);
}

// ------------------------------------------------------------------ row

interface RowProps {
  nodeKey: string;
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  extra?: ReactNode;
  hasChildren?: boolean;
  open?: boolean;
  onToggle?: (open?: boolean) => void;
  /** Single click (in addition to selecting). Defaults to toggling. */
  onClick?: () => void;
  /** Enter / double-click. */
  onActivate?: () => void;
  menu?: () => MenuItem[];
  loading?: boolean;
  active?: boolean;
  title?: string;
  muted?: boolean;
}

const Row = memo(function Row({
  nodeKey, depth, icon, label, extra, hasChildren = false, open, onToggle, onClick, onActivate, menu, loading, active, title, muted,
}: RowProps) {
  const selected = useTree((s) => s.selected === nodeKey);
  const select = useTree((s) => s.select);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (hasChildren && !open) onToggle?.(true);
      else if (hasChildren && open) focusSibling(e.currentTarget, 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (hasChildren && open) onToggle?.(false);
      else focusParent(e.currentTarget);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (onActivate) onActivate();
      else if (hasChildren) onToggle?.();
      else onClick?.();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (hasChildren) onToggle?.();
      else onClick?.();
    }
  };
  const body = (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !!open : undefined}
      aria-selected={selected}
      data-depth={depth}
      tabIndex={selected ? 0 : -1}
      title={title}
      onFocus={() => !selected && select(nodeKey)}
      onKeyDown={onKeyDown}
      onClick={() => {
        select(nodeKey);
        if (onClick) onClick();
        else if (hasChildren) onToggle?.();
      }}
      onDoubleClick={onActivate}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-1.5 rounded-md pr-2 text-[13px] outline-none select-none',
        'hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-inset',
        selected && 'bg-active',
        active && 'bg-accent-soft text-fg',
        muted && 'text-muted',
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center text-subtle hover:text-fg"
        onClick={(e) => {
          if (!hasChildren || !onToggle) return;
          e.stopPropagation();
          select(nodeKey);
          onToggle();
        }}
      >
        {loading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : hasChildren ? (
          <ChevronRight size={13} className={cn('transition-transform duration-150', open && 'rotate-90')} />
        ) : null}
      </span>
      <span className="-ml-0.5 flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra != null && extra !== '' && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-subtle tabular-nums">{extra}</span>}
    </div>
  );
  return menu ? <ContextMenu items={menu}>{body}</ContextMenu> : body;
});

function treeItems(from: HTMLElement): HTMLElement[] {
  const tree = from.closest('[role=tree]');
  return tree ? Array.from(tree.querySelectorAll<HTMLElement>('[role=treeitem]')) : [];
}
function focusSibling(el: HTMLElement, delta: number) {
  const items = treeItems(el);
  const i = items.indexOf(el);
  items[Math.max(0, Math.min(items.length - 1, i + delta))]?.focus();
}
function focusParent(el: HTMLElement) {
  const items = treeItems(el);
  const depth = Number(el.dataset.depth);
  for (let i = items.indexOf(el) - 1; i >= 0; i--) {
    if (Number(items[i].dataset.depth) < depth) return items[i].focus();
  }
}

function StatusRow({ depth, error, onRetry, text }: { depth: number; error?: unknown; onRetry?: () => void; text?: string }) {
  return (
    <div className="flex h-[26px] items-center gap-1.5 pr-2 text-[12px]" style={{ paddingLeft: 4 + depth * 14 + 18 }}>
      {error ? (
        <>
          <AlertCircle size={12} className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 truncate text-danger" title={errorText(error)}>{errorText(error)}</span>
          {onRetry && <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={onRetry}>Retry</button>}
        </>
      ) : (
        <span className="text-subtle italic">{text}</span>
      )}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-warning-soft text-fg">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

const useNode = (key: string) => {
  const open = useExpanded(key);
  const toggle = useTree((s) => s.toggle);
  return { open, toggle: useCallback((force?: boolean) => toggle(key, force), [toggle, key]) };
};

// ------------------------------------------------------------------ root

export function ExplorerTree() {
  const list = useConnections((s) => s.list);
  const [filter, setFilter] = useState('');
  const show = useConnectionDialog((s) => s.show);
  const collapseAll = useTree((s) => s.collapseAll);
  const treeRef = useRef<HTMLDivElement>(null);
  const q = filter.trim().toLowerCase();

  const groups = useMemo(() => {
    const m = new Map<string, ConnectionConfig[]>();
    for (const c of list) {
      const g = c.group?.trim() || '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return [...m.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [list]);

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el.getAttribute('role') !== 'treeitem') return;
    const items = treeItems(el);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusSibling(el, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusSibling(el, -1); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-3">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">Explorer</span>
        <IconButton
          label="Refresh all"
          size="xs"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['schemas'] });
            queryClient.invalidateQueries({ queryKey: ['objects'] });
            queryClient.invalidateQueries({ queryKey: ['columns'] });
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
        <IconButton label="Collapse all" size="xs" onClick={collapseAll}><ChevronsDownUp size={13} /></IconButton>
        <IconButton label="New connection" size="xs" onClick={() => show()}><Plus size={14} /></IconButton>
      </div>
      <div className="relative px-2 pb-2">
        <Input
          size="sm"
          icon={<Search size={12} />}
          placeholder="Filter objects…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              treeRef.current?.querySelector<HTMLElement>('[role=treeitem]')?.focus();
            }
          }}
        />
        {filter && (
          <button aria-label="Clear filter" className="absolute top-1.5 right-3.5 rounded p-0.5 text-subtle hover:bg-hover hover:text-fg" onClick={() => setFilter('')}>
            <X size={12} />
          </button>
        )}
      </div>
      <div ref={treeRef} role="tree" aria-label="Database objects" className="min-h-0 flex-1 overflow-auto px-1.5 pb-4" onKeyDown={onTreeKey}>
        {groups.map(([g, conns]) => (
          <div key={g || '_'} role="group">
            {g && <div className="px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wider text-subtle uppercase">{g}</div>}
            {conns.map((c) => <ConnectionNode key={c.id} conn={c} q={q} />)}
          </div>
        ))}
        {list.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No connections yet.
            <button className="mt-2 block w-full text-accent hover:underline" onClick={() => show()}>Add a connection</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ connection & database

function ConnectionNode({ conn, q }: { conn: ConnectionConfig; q: string }) {
  const st = useConnections((s) => s.state[conn.id]);
  const { connect, disconnect, remove } = useConnections.getState();
  const show = useConnectionDialog((s) => s.show);
  const key = `c:${conn.id}`;
  const node = useNode(key);
  const open = node.open && st?.status === 'connected';

  const toggle = async (force?: boolean) => {
    if (st?.status === 'connected') return node.toggle(force);
    if (force === false) return;
    try {
      await connect(conn.id);
      node.toggle(true);
    } catch (e: any) {
      toast.error(`${conn.name}: ${e.message}`);
    }
  };

  const ws = useWorkspace.getState();
  const menu = (): MenuItem[] => [
    { label: 'New query', icon: <FileCode2 size={14} />, onSelect: () => ws.newQuery({ connId: conn.id, database: conn.database }) },
    { label: 'Server dashboard', icon: <Activity size={14} />, onSelect: () => ws.openTab({ kind: 'dashboard', title: `Dashboard · ${conn.name}`, connId: conn.id, database: conn.database, key: `dash:${conn.id}` }) },
    'separator',
    st?.status === 'connected'
      ? { label: 'Disconnect', icon: <Unplug size={14} />, onSelect: () => disconnect(conn.id) }
      : { label: 'Connect', icon: <Plug size={14} />, onSelect: () => toggle(true) },
    { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => useConnections.getState().refresh(conn.id).catch((e) => toast.error(errorText(e))) },
    ...(st?.status === 'connected' ? [{ label: 'Create database…', icon: <Database size={14} />, onSelect: () => createDatabase(conn.id) }] : []),
    'separator',
    { label: 'Edit connection…', icon: <Pencil size={14} />, onSelect: () => show(conn) },
    { label: 'Duplicate', onSelect: () => useConnections.getState().save({ ...conn, id: '', name: conn.name + ' copy', password: undefined }) },
    'separator',
    {
      label: 'Delete connection', icon: <Trash2 size={14} />, danger: true,
      onSelect: async () => { if (await confirm({ title: `Delete “${conn.name}”?`, message: 'The saved connection will be removed. No data on the server is touched.', danger: true, confirmLabel: 'Delete' })) remove(conn.id); },
    },
  ];

  const expanded = useTree((s) => s.expanded);
  const dbs = (st?.info?.databases.filter((d) => !d.isTemplate && d.allowConn) ?? [])
    // while filtering, only databases that are open (and may contain matches) or whose name matches
    .filter((d) => !q || expanded.has(`d:${conn.id}:${d.name}`) || d.name.toLowerCase().includes(q));
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={0}
        hasChildren
        open={open}
        onToggle={toggle}
        loading={st?.status === 'connecting'}
        icon={
          <span className="relative mr-0.5 flex">
            <Database size={14} style={{ color: conn.color || 'var(--accent)' }} />
            <span className={cn('absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-panel', st?.status === 'connected' ? 'bg-success' : st?.status === 'error' ? 'bg-danger' : 'bg-transparent')} />
          </span>
        }
        label={<span className="font-medium">{conn.name}</span>}
        extra={st?.status === 'error' ? <AlertCircle size={12} className="text-danger" /> : conn.readOnly ? 'RO' : open ? dbs.length : undefined}
        title={st?.error ?? `${conn.user}@${conn.host}:${conn.port}/${conn.database}`}
        menu={menu}
      />
      {open && dbs.map((d) => <DatabaseNode key={d.name} conn={conn} db={d.name} size={d.sizeBytes} q={q} />)}
    </div>
  );
}

function DatabaseNode({ conn, db, size, q }: { conn: ConnectionConfig; db: string; size: number | null; q: string }) {
  const key = `d:${conn.id}:${db}`;
  const node = useNode(key);
  const active = useWorkspace((s) => s.activeConnId === conn.id && s.activeDb === db);
  const setActiveDb = useWorkspace((s) => s.setActiveDb);
  const isDefault = conn.database === db;
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={1}
        hasChildren
        open={node.open}
        onToggle={(f) => { node.toggle(f); setActiveDb(conn.id, db); }}
        onActivate={() => useWorkspace.getState().newQuery({ connId: conn.id, database: db })}
        active={active}
        icon={<Database size={14} className={isDefault ? 'text-accent' : 'text-muted'} />}
        label={db}
        extra={size != null ? formatBytes(size) : undefined}
        title={`${db}${size != null ? ` · ${formatBytes(size)}` : ''}\nEnter: new query`}
        menu={() => databaseMenu(conn.id, db)}
      />
      {node.open && (
        <>
          <SchemasFolder conn={conn} db={db} q={q} />
          <ExtensionsFolder conn={conn} db={db} q={q} />
        </>
      )}
    </div>
  );
}

function SchemasFolder({ conn, db, q }: { conn: ConnectionConfig; db: string; q: string }) {
  const key = `sf:${conn.id}:${db}`;
  // Schemas are shown by default; the folder is "collapsed" only when explicitly closed.
  const closedKey = `${key}~closed`;
  const closed = useExpanded(closedKey);
  const toggleClosed = useTree((s) => s.toggle);
  const open = !closed || !!q;
  const showSystem = useSettings((s) => s.showSystemSchemas);
  const qy = useQuery({ queryKey: ['schemas', conn.id, db, showSystem], queryFn: () => api.schemas(conn.id, db, showSystem) });
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={2}
        hasChildren
        open={open}
        onToggle={(f) => toggleClosed(closedKey, f === undefined ? undefined : !f)}
        loading={qy.isFetching && !qy.data}
        icon={<Folder size={14} className="text-subtle" />}
        label={<span className="text-muted">Schemas</span>}
        extra={qy.data?.length}
        menu={() => schemasFolderMenu(conn.id, db)}
      />
      {open && qy.error && <StatusRow depth={3} error={qy.error} onRetry={() => qy.refetch()} />}
      {open && qy.data?.map((s) => <SchemaNode key={s.name} conn={conn} db={db} schema={s.name} comment={s.comment} q={q} />)}
    </div>
  );
}

function ExtensionsFolder({ conn, db, q }: { conn: ConnectionConfig; db: string; q: string }) {
  const key = `ef:${conn.id}:${db}`;
  const node = useNode(key);
  const qy = useQuery({
    queryKey: schemaKeys.extensions(conn.id, db),
    queryFn: () => schemaApi.extensions(conn.id, db),
    select: (l) => l.filter((e) => e.installedVersion),
  });
  const items = (qy.data ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
  if (q && !items.length) return null;
  const open = node.open || (!!q && items.length > 0);
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={2}
        hasChildren
        open={open}
        onToggle={node.toggle}
        loading={qy.isFetching && !qy.data}
        icon={<Folder size={14} className="text-subtle" />}
        label={<span className="text-muted">Extensions</span>}
        extra={qy.data?.length}
        menu={() => extensionsFolderMenu(conn.id, db)}
      />
      {open && qy.error && <StatusRow depth={3} error={qy.error} onRetry={() => qy.refetch()} />}
      {open && items.map((e) => <ExtensionNode key={e.name} conn={conn} db={db} ext={e} q={q} />)}
    </div>
  );
}

function ExtensionNode({ conn, db, ext, q }: { conn: ConnectionConfig; db: string; ext: ExtensionInfo; q: string }) {
  return (
    <Row
      nodeKey={`e:${conn.id}:${db}:${ext.name}`}
      depth={3}
      icon={objectIcon('extension')}
      label={<Highlight text={ext.name} q={q} />}
      extra={ext.installedVersion}
      title={`${ext.name} ${ext.installedVersion} (schema ${ext.schema})${ext.comment ? `\n${ext.comment}` : ''}`}
      menu={() => extensionMenu(conn.id, db, ext)}
    />
  );
}

// ------------------------------------------------------------------ schema & groups

function SchemaNode({ conn, db, schema, comment, q }: { conn: ConnectionConfig; db: string; schema: string; comment?: string | null; q: string }) {
  const key = `s:${conn.id}:${db}:${schema}`;
  const node = useNode(key);
  const setActiveDb = useWorkspace((s) => s.setActiveDb);
  const filtering = !!q;
  const qy = useQuery({ queryKey: ['objects', conn.id, db, schema], queryFn: () => api.objects(conn.id, db, schema), enabled: node.open || filtering });
  const all = qy.data ?? [];
  const objs = filtering ? all.filter((o) => o.name.toLowerCase().includes(q)) : all;
  if (filtering && qy.data && objs.length === 0) return null;
  const open = node.open || (filtering && objs.length > 0);
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={3}
        hasChildren
        open={open}
        onToggle={(f) => { node.toggle(f); setActiveDb(conn.id, db); }}
        loading={qy.isFetching && !qy.data}
        icon={<FolderTree size={14} className="text-muted" />}
        label={schema}
        extra={qy.data ? (filtering ? `${objs.length}/${all.length}` : all.length) : undefined}
        title={comment ?? undefined}
        menu={() => schemaMenu(conn.id, db, schema)}
      />
      {open && qy.error && <StatusRow depth={4} error={qy.error} onRetry={() => qy.refetch()} />}
      {open && qy.data && all.length === 0 && <StatusRow depth={4} text="Empty schema" />}
      {open &&
        GROUPS.map((g) => {
          const items = objs.filter((o) => g.kinds.includes(o.kind));
          if (!items.length) return null;
          return <GroupNode key={g.label} conn={conn} db={db} schema={schema} label={g.label} icon={g.icon} items={items} q={q} />;
        })}
    </div>
  );
}

function GroupNode({ conn, db, schema, label, icon, items, q }: { conn: ConnectionConfig; db: string; schema: string; label: string; icon: ReactNode; items: DbObject[]; q: string }) {
  const key = `g:${conn.id}:${db}:${schema}:${label}`;
  const node = useNode(key);
  const open = node.open || !!q;
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={4}
        hasChildren
        open={open}
        onToggle={node.toggle}
        icon={<span className="opacity-70">{icon}</span>}
        label={<span className="text-muted">{label}</span>}
        extra={items.length}
        menu={label === 'Tables' ? () => [{ label: 'New table…', icon: <Plus size={14} />, onSelect: () => useWorkspace.getState().openTab({ kind: 'create-table', title: 'New table', connId: conn.id, database: db, params: { schema } }) }] : undefined}
      />
      {open && items.map((o) => <ObjectNode key={`${o.kind}:${o.oid}`} conn={conn} db={db} obj={o} depth={5} q={q} />)}
    </div>
  );
}

// ------------------------------------------------------------------ objects

function ObjectNode({ conn, db, obj, depth, q = '' }: { conn: ConnectionConfig; db: string; obj: DbObject; depth: number; q?: string }) {
  const key = `o:${conn.id}:${db}:${obj.schema}:${obj.kind}:${obj.name}`;
  const node = useNode(key);
  const activeKey = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId)?.key);
  const rel = isRelation(obj.kind);
  const expandable = rel;
  const isActive =
    activeKey === `data:${conn.id}:${db}:${obj.schema}.${obj.name}` ||
    activeKey === `struct:${conn.id}:${db}:${obj.schema}.${obj.name}` ||
    activeKey === `obj:${conn.id}:${db}:${obj.kind}:${obj.oid}`;
  const label = obj.args !== undefined
    ? <><Highlight text={obj.name} q={q} /><span className="text-subtle">({obj.args})</span></>
    : <Highlight text={obj.name} q={q} />;
  const extra = obj.estRows != null && Number(obj.estRows) > 0 ? formatCount(Number(obj.estRows)) : undefined;
  const titleParts = [`${obj.schema}.${obj.name}${obj.args !== undefined ? `(${obj.args})` : ''}`, obj.kind.replace(/_/g, ' ')];
  if (obj.sizeBytes != null) titleParts.push(formatBytes(obj.sizeBytes));
  if (obj.comment) titleParts.push(obj.comment);
  return (
    <div role="group">
      <Row
        nodeKey={key}
        depth={depth}
        hasChildren={expandable}
        open={node.open}
        onToggle={node.toggle}
        icon={objectIcon(obj.kind)}
        label={label}
        extra={extra}
        title={titleParts.join(' · ')}
        active={isActive}
        onClick={() => openObject(conn.id, db, obj, true)}
        onActivate={() => openObject(conn.id, db, obj, false)}
        menu={() => objectMenu(conn.id, db, obj)}
      />
      {node.open && isTableKind(obj.kind) && <TableChildren conn={conn} db={db} obj={obj} depth={depth + 1} parentKey={key} />}
      {node.open && (obj.kind === 'view' || obj.kind === 'materialized_view') && <ViewColumns conn={conn} db={db} obj={obj} depth={depth + 1} />}
    </div>
  );
}

function ViewColumns({ conn, db, obj, depth }: { conn: ConnectionConfig; db: string; obj: DbObject; depth: number }) {
  const qy = useQuery({ queryKey: ['columns', conn.id, db, obj.schema, obj.name], queryFn: () => api.columns(conn.id, db, obj.schema, obj.name) });
  if (qy.isLoading) return <StatusRow depth={depth} text="Loading…" />;
  if (qy.error) return <StatusRow depth={depth} error={qy.error} onRetry={() => qy.refetch()} />;
  return (
    <>
      {qy.data?.map((c) => (
        <Row
          key={c.name}
          nodeKey={`col:${conn.id}:${db}:${obj.schema}.${obj.name}.${c.name}`}
          depth={depth}
          icon={<Columns3 size={12} className="text-subtle" />}
          label={c.name}
          extra={<span className="font-mono">{shortType(c.dataType)}</span>}
          title={`${c.name} ${c.dataType}${c.comment ? ` — ${c.comment}` : ''}`}
          onActivate={() => openObjectTab(conn.id, db, obj)}
          menu={() => [{ label: 'Copy name', onSelect: () => navigator.clipboard.writeText(c.name) }]}
        />
      ))}
    </>
  );
}

/** Compact type name for the tree (character varying(120) → varchar(120)). */
function shortType(t: string): string {
  return t
    .replace('character varying', 'varchar')
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('time with time zone', 'timetz')
    .replace('double precision', 'float8')
    .replace(/^character\b/, 'char')
    .replace('boolean', 'bool')
    .replace('integer', 'int4')
    .replace('bigint', 'int8')
    .replace('smallint', 'int2');
}

function SubFolder({ nodeKey, depth, label, count, icon, defaultOpen, children, menu }: {
  nodeKey: string; depth: number; label: string; count: number; icon: ReactNode; defaultOpen?: boolean; children: ReactNode; menu?: () => MenuItem[];
}) {
  // defaultOpen folders store the inverse ("closed") state
  const stateKey = defaultOpen ? `${nodeKey}~closed` : nodeKey;
  const flag = useExpanded(stateKey);
  const toggle = useTree((s) => s.toggle);
  const open = defaultOpen ? !flag : flag;
  if (count === 0) return null;
  return (
    <div role="group">
      <Row
        nodeKey={nodeKey}
        depth={depth}
        hasChildren
        open={open}
        onToggle={(f) => toggle(stateKey, defaultOpen ? (f === undefined ? undefined : !f) : f)}
        icon={icon}
        label={<span className="text-muted">{label}</span>}
        extra={count}
        menu={menu}
      />
      {open && children}
    </div>
  );
}

const CONSTRAINT_ICON: Record<string, ReactNode> = {
  p: <KeyRound size={12} className="text-warning" />,
  f: <Link2 size={12} className="text-info" />,
  u: <Fingerprint size={12} className="text-accent" />,
  c: <ShieldCheck size={12} className="text-success" />,
  x: <Ban size={12} className="text-danger" />,
  t: <Zap size={12} className="text-warning" />,
};
const CONSTRAINT_TAG: Record<string, string> = { p: 'PK', f: 'FK', u: 'UQ', c: 'CHECK', x: 'EXCL', t: 'TRIG' };

function TableChildren({ conn, db, obj, depth, parentKey }: { conn: ConnectionConfig; db: string; obj: DbObject; depth: number; parentKey: string }) {
  const qy = useTableDetails(conn.id, db, obj.schema, obj.name);
  const c = conn.id;
  const t = qy.data;
  if (qy.isLoading) return <StatusRow depth={depth} text="Loading…" />;
  if (qy.error) return <StatusRow depth={depth} error={qy.error} onRetry={() => qy.refetch()} />;
  if (!t) return null;
  const struct = (section: string) => () => openStructure(c, db, obj.schema, obj.name, obj.kind, section);
  const tref = fq(obj.schema, obj.name);
  return (
    <>
      <SubFolder nodeKey={`${parentKey}/cols`} depth={depth} label="Columns" count={t.columns.length} defaultOpen icon={<Columns3 size={13} className="text-subtle" />}>
        {t.columns.map((col) => (
          <Row
            key={col.attnum}
            nodeKey={`${parentKey}/cols/${col.name}`}
            depth={depth + 1}
            icon={col.isPrimaryKey ? <KeyRound size={12} className="text-warning" /> : col.fk ? <Link2 size={12} className="text-info" /> : <Columns3 size={12} className="text-subtle" />}
            label={<span className={cn(col.isPrimaryKey && 'font-medium')}>{col.name}</span>}
            extra={<span className="font-mono">{shortType(col.dataType)}{col.nullable ? '' : ''}</span>}
            title={`${col.name} ${col.dataType}${col.nullable ? '' : ' NOT NULL'}${col.default ? ` DEFAULT ${col.default}` : ''}${col.fk ? `\n→ ${col.fk.schema}.${col.fk.table}.${col.fk.column}` : ''}${col.comment ? `\n${col.comment}` : ''}`}
            onActivate={struct('columns')}
            menu={() => [
              { label: 'Edit in structure', icon: <TableProperties size={14} />, onSelect: struct('columns') },
              ...(col.fk ? [{ label: `Go to ${col.fk.table}`, icon: <Link2 size={14} />, onSelect: () => openStructure(c, db, col.fk!.schema, col.fk!.table) }] : []),
              'separator',
              { label: 'Copy name', onSelect: () => navigator.clipboard.writeText(col.name) },
              'separator',
              {
                label: 'Drop column…', icon: <Trash2 size={14} />, danger: true, disabled: col.inherited,
                onSelect: () => runDdl({ connId: c, db, title: `Drop column ${col.name}?`, danger: true, confirmLabel: 'Drop', statements: [`ALTER TABLE ${tref} DROP COLUMN ${qi(col.name)}`], success: `Dropped ${col.name}` }),
              },
            ]}
          />
        ))}
      </SubFolder>
      <SubFolder nodeKey={`${parentKey}/idx`} depth={depth} label="Indexes" count={t.indexes.length} icon={<ListOrdered size={13} className="text-subtle" />}>
        {t.indexes.map((ix: IndexDetail) => (
          <Row
            key={ix.oid}
            nodeKey={`${parentKey}/idx/${ix.name}`}
            depth={depth + 1}
            icon={<ListOrdered size={12} className={ix.isPrimary ? 'text-warning' : ix.isUnique ? 'text-accent' : 'text-syntax-number'} />}
            label={ix.name}
            extra={ix.isPrimary ? 'pk' : ix.isUnique ? 'unique' : ix.method !== 'btree' ? ix.method : undefined}
            title={ix.definition}
            onActivate={struct('indexes')}
            menu={() => [
              { label: 'Show in structure', icon: <TableProperties size={14} />, onSelect: struct('indexes') },
              { label: 'Copy definition', onSelect: () => navigator.clipboard.writeText(ix.definition + ';') },
              { label: 'Reindex', icon: <RefreshCw size={14} />, onSelect: () => runDdl({ connId: c, db, title: 'Reindex', statements: [`REINDEX INDEX ${fq(obj.schema, ix.name)}`], transaction: false, success: `Reindexed ${ix.name}`, confirmLabel: 'Run' }) },
              'separator',
              ix.constraint
                ? { label: `Backs constraint ${ix.constraint}`, disabled: true }
                : { label: 'Drop index…', icon: <Trash2 size={14} />, danger: true, onSelect: () => dropObject(c, db, 'index', obj.schema, ix.name) },
            ]}
          />
        ))}
      </SubFolder>
      <SubFolder nodeKey={`${parentKey}/con`} depth={depth} label="Constraints" count={t.constraints.length} icon={<ShieldCheck size={13} className="text-subtle" />}>
        {t.constraints.map((k: ConstraintDetail) => (
          <Row
            key={k.oid}
            nodeKey={`${parentKey}/con/${k.name}`}
            depth={depth + 1}
            icon={CONSTRAINT_ICON[k.type]}
            label={k.name}
            extra={CONSTRAINT_TAG[k.type]}
            title={k.definition}
            onActivate={struct(k.type === 'f' ? 'foreign-keys' : 'constraints')}
            menu={() => [
              { label: 'Show in structure', icon: <TableProperties size={14} />, onSelect: struct(k.type === 'f' ? 'foreign-keys' : 'constraints') },
              ...(k.type === 'f' && k.refTable ? [{ label: `Go to ${k.refTable}`, icon: <Link2 size={14} />, onSelect: () => openStructure(c, db, k.refSchema!, k.refTable!) }] : []),
              { label: 'Copy definition', onSelect: () => navigator.clipboard.writeText(k.definition) },
              'separator',
              {
                label: 'Drop constraint…', icon: <Trash2 size={14} />, danger: true, disabled: !k.isLocal,
                onSelect: () => runDdl({ connId: c, db, title: `Drop constraint ${k.name}?`, danger: true, confirmLabel: 'Drop', statements: [`ALTER TABLE ${tref} DROP CONSTRAINT ${qi(k.name)}`], success: `Dropped ${k.name}` }),
              },
            ]}
          />
        ))}
      </SubFolder>
      <SubFolder nodeKey={`${parentKey}/trg`} depth={depth} label="Triggers" count={t.triggers.length} icon={<Zap size={13} className="text-subtle" />}>
        {t.triggers.map((tr: TriggerDetail) => (
          <Row
            key={tr.oid}
            nodeKey={`${parentKey}/trg/${tr.name}`}
            depth={depth + 1}
            icon={<Zap size={12} className={tr.enabled === 'D' ? 'text-subtle' : 'text-warning'} />}
            label={<span className={cn(tr.enabled === 'D' && 'text-subtle line-through')}>{tr.name}</span>}
            extra={`${tr.timing === 'INSTEAD OF' ? 'instead' : tr.timing.toLowerCase()} ${tr.events.map((e) => e.toLowerCase()).join('/')}`}
            title={tr.definition}
            onActivate={struct('triggers')}
            menu={() => [
              { label: 'Show in structure', icon: <TableProperties size={14} />, onSelect: struct('triggers') },
              { label: `Open function ${tr.functionName}`, icon: <FunctionSquare size={14} />, onSelect: () => openObjectTab(c, db, { schema: tr.functionSchema, name: tr.functionName, kind: 'function', oid: tr.functionOid }) },
              { label: tr.enabled === 'D' ? 'Enable trigger' : 'Disable trigger', onSelect: () => runDdl({ connId: c, db, title: '', skipConfirm: true, statements: [`ALTER TABLE ${tref} ${tr.enabled === 'D' ? 'ENABLE' : 'DISABLE'} TRIGGER ${qi(tr.name)}`], success: `Trigger ${tr.name} ${tr.enabled === 'D' ? 'enabled' : 'disabled'}` }) },
              { label: 'Copy definition', onSelect: () => navigator.clipboard.writeText(tr.definition + ';') },
              'separator',
              { label: 'Drop trigger…', icon: <Trash2 size={14} />, danger: true, disabled: tr.isInherited, onSelect: () => runDdl({ connId: c, db, title: `Drop trigger ${tr.name}?`, danger: true, confirmLabel: 'Drop', statements: [`DROP TRIGGER ${qi(tr.name)} ON ${tref}`], success: `Dropped ${tr.name}` }) },
            ]}
          />
        ))}
      </SubFolder>
      {t.partitions.length > 0 && (
        <SubFolder nodeKey={`${parentKey}/parts`} depth={depth} label="Partitions" count={t.partitions.length} defaultOpen icon={<Layers size={13} className="text-subtle" />}>
          {t.partitions.map((p) => (
            <ObjectNode key={p.oid} conn={conn} db={db} depth={depth + 1} obj={{ oid: p.oid, schema: p.schema, name: p.name, kind: p.kind, estRows: p.estRows, sizeBytes: p.sizeBytes, comment: p.bound }} />
          ))}
        </SubFolder>
      )}
    </>
  );
}
