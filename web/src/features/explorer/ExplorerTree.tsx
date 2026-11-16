import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight, Database, Eye, FolderTree, FunctionSquare, Hash, Layers, Loader2, Plus, RefreshCw, Search, Shapes, Table2, Plug, Pencil, Trash2,
  Unplug, FileCode2, Activity, AlertCircle,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ConnectionConfig, DbObject, DbObjectKind } from '@shared/types';
import { ContextMenu, IconButton, Input, toast, type MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { invalidateDb } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { confirm } from '@/stores/dialogs';
import { useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { useConnectionDialog } from '../connections/ConnectionDialog';

/**
 * Sidebar object explorer: connections → databases → schemas → object groups → objects.
 * (Basic version; owned by the Explorer/Structure team.)
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
  return GROUPS.find((g) => g.kinds.includes(kind))?.icon ?? <Table2 size={14} />;
}

function Row({
  depth, open, onToggle, icon, label, extra, onClick, onDoubleClick, active, loading, menu, hasChildren = true, title,
}: {
  depth: number; open?: boolean; onToggle?: () => void; icon: ReactNode; label: ReactNode; extra?: ReactNode;
  onClick?: () => void; onDoubleClick?: () => void; active?: boolean; loading?: boolean; menu?: () => MenuItem[]; hasChildren?: boolean; title?: string;
}) {
  const body = (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      title={title}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-1 rounded-md pr-2 text-[13px] select-none hover:bg-hover',
        active && 'bg-accent-soft text-fg',
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick ?? onToggle}
      onDoubleClick={onDoubleClick}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center text-subtle"
        onClick={(e) => { if (onToggle && onClick) { e.stopPropagation(); onToggle(); } }}
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : hasChildren ? <ChevronRight size={13} className={cn('transition-transform duration-100', open && 'rotate-90')} /> : null}
      </span>
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra && <span className="shrink-0 text-[11px] text-subtle">{extra}</span>}
    </div>
  );
  return menu ? <ContextMenu items={menu}>{body}</ContextMenu> : body;
}

function useExpanded() {
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('pgstudio.explorer.expanded') || '[]')); } catch { return new Set(); }
  });
  const toggle = (k: string, force?: boolean) =>
    setSet((s) => {
      const n = new Set(s);
      const on = force ?? !n.has(k);
      if (on) n.add(k); else n.delete(k);
      try { localStorage.setItem('pgstudio.explorer.expanded', JSON.stringify([...n])); } catch { /* */ }
      return n;
    });
  return { has: (k: string) => set.has(k), toggle };
}

export function ExplorerTree() {
  const list = useConnections((s) => s.list);
  const [filter, setFilter] = useState('');
  const exp = useExpanded();
  const show = useConnectionDialog((s) => s.show);

  const groups = useMemo(() => {
    const m = new Map<string, ConnectionConfig[]>();
    for (const c of list) {
      const g = c.group?.trim() || '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return [...m.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [list]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">Explorer</span>
        <IconButton label="New connection" size="xs" onClick={() => show()}><Plus size={14} /></IconButton>
      </div>
      <div className="px-2 pb-2">
        <Input size="sm" icon={<Search size={12} />} placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div role="tree" className="min-h-0 flex-1 overflow-auto px-1.5 pb-4">
        {groups.map(([g, conns]) => (
          <div key={g || '_'}>
            {g && <div className="px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wider text-subtle uppercase">{g}</div>}
            {conns.map((c) => <ConnectionNode key={c.id} conn={c} exp={exp} filter={filter.toLowerCase()} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

type Exp = ReturnType<typeof useExpanded>;

function ConnectionNode({ conn, exp, filter }: { conn: ConnectionConfig; exp: Exp; filter: string }) {
  const st = useConnections((s) => s.state[conn.id]);
  const { connect, disconnect, remove } = useConnections.getState();
  const show = useConnectionDialog((s) => s.show);
  const ws = useWorkspace.getState();
  const key = `c:${conn.id}`;
  const open = exp.has(key) && st?.status === 'connected';

  const toggle = async () => {
    if (st?.status === 'connected') return exp.toggle(key);
    try {
      await connect(conn.id);
      exp.toggle(key, true);
    } catch (e: any) {
      toast.error(`${conn.name}: ${e.message}`);
    }
  };

  const menu = (): MenuItem[] => [
    { label: 'New query', icon: <FileCode2 size={14} />, onSelect: () => ws.newQuery({ connId: conn.id, database: conn.database }) },
    { label: 'Server dashboard', icon: <Activity size={14} />, onSelect: () => ws.openTab({ kind: 'dashboard', title: `Dashboard · ${conn.name}`, connId: conn.id, database: conn.database, key: `dash:${conn.id}` }) },
    'separator',
    st?.status === 'connected'
      ? { label: 'Disconnect', icon: <Unplug size={14} />, onSelect: () => disconnect(conn.id) }
      : { label: 'Connect', icon: <Plug size={14} />, onSelect: toggle },
    { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => useConnections.getState().refresh(conn.id) },
    { label: 'Edit connection…', icon: <Pencil size={14} />, onSelect: () => show(conn) },
    { label: 'Duplicate', onSelect: () => useConnections.getState().save({ ...conn, id: '', name: conn.name + ' copy', password: undefined }) },
    'separator',
    {
      label: 'Delete', icon: <Trash2 size={14} />, danger: true,
      onSelect: async () => { if (await confirm({ title: `Delete “${conn.name}”?`, message: 'The saved connection will be removed. No data on the server is touched.', danger: true, confirmLabel: 'Delete' })) remove(conn.id); },
    },
  ];

  const dbs = st?.info?.databases.filter((d) => !d.isTemplate && d.allowConn) ?? [];
  return (
    <div>
      <Row
        depth={0}
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
        extra={st?.status === 'error' ? <AlertCircle size={12} className="text-danger" /> : conn.readOnly ? 'RO' : undefined}
        title={st?.error ?? `${conn.user}@${conn.host}:${conn.port}/${conn.database}`}
        menu={menu}
      />
      {open && dbs.map((d) => <DatabaseNode key={d.name} conn={conn} db={d.name} exp={exp} filter={filter} />)}
    </div>
  );
}

function DatabaseNode({ conn, db, exp, filter }: { conn: ConnectionConfig; db: string; exp: Exp; filter: string }) {
  const key = `d:${conn.id}:${db}`;
  const open = exp.has(key) || (!!filter && exp.has(key));
  const showSystem = useSettings((s) => s.showSystemSchemas);
  const activeConnId = useWorkspace((s) => s.activeConnId);
  const activeDb = useWorkspace((s) => s.activeDb);
  const ws = useWorkspace.getState();
  const q = useQuery({ queryKey: ['schemas', conn.id, db, showSystem], queryFn: () => api.schemas(conn.id, db, showSystem), enabled: open });
  return (
    <div>
      <Row
        depth={1}
        open={open}
        onToggle={() => { exp.toggle(key); ws.setActiveDb(conn.id, db); }}
        active={activeConnId === conn.id && activeDb === db}
        loading={q.isFetching && !q.data}
        icon={<Database size={14} className="text-muted" />}
        label={db}
        menu={() => [
          { label: 'New query', icon: <FileCode2 size={14} />, onSelect: () => ws.newQuery({ connId: conn.id, database: db }) },
          { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => invalidateDb(conn.id, db) },
        ]}
      />
      {open && q.data?.map((s) => <SchemaNode key={s.name} conn={conn} db={db} schema={s.name} exp={exp} filter={filter} />)}
    </div>
  );
}

function SchemaNode({ conn, db, schema, exp, filter }: { conn: ConnectionConfig; db: string; schema: string; exp: Exp; filter: string }) {
  const key = `s:${conn.id}:${db}:${schema}`;
  const open = exp.has(key);
  const ws = useWorkspace.getState();
  const q = useQuery({ queryKey: ['objects', conn.id, db, schema], queryFn: () => api.objects(conn.id, db, schema), enabled: open });
  const objs = (q.data ?? []).filter((o) => !filter || o.name.toLowerCase().includes(filter));
  return (
    <div>
      <Row
        depth={2}
        open={open}
        onToggle={() => { exp.toggle(key); ws.setActiveDb(conn.id, db); }}
        loading={q.isFetching && !q.data}
        icon={<FolderTree size={14} className="text-muted" />}
        label={schema}
        menu={() => [
          { label: 'New query', icon: <FileCode2 size={14} />, onSelect: () => ws.newQuery({ connId: conn.id, database: db, sql: `SET search_path TO ${schema};\n\n` }) },
          { label: 'Refresh', icon: <RefreshCw size={14} />, onSelect: () => invalidateDb(conn.id, db) },
        ]}
      />
      {open &&
        GROUPS.map((g) => {
          const items = objs.filter((o) => g.kinds.includes(o.kind));
          if (!items.length) return null;
          return <GroupNode key={g.label} conn={conn} db={db} schema={schema} label={g.label} icon={g.icon} items={items} exp={exp} forceOpen={!!filter} />;
        })}
    </div>
  );
}

function GroupNode({ conn, db, schema, label, icon, items, exp, forceOpen }: { conn: ConnectionConfig; db: string; schema: string; label: string; icon: ReactNode; items: DbObject[]; exp: Exp; forceOpen: boolean }) {
  const key = `g:${conn.id}:${db}:${schema}:${label}`;
  const open = forceOpen || exp.has(key);
  return (
    <div>
      <Row depth={3} open={open} onToggle={() => exp.toggle(key)} icon={<span className="opacity-70">{icon}</span>} label={<span className="text-muted">{label}</span>} extra={items.length} />
      {open && items.map((o) => <ObjectNode key={`${o.kind}:${o.oid}`} conn={conn} db={db} obj={o} />)}
    </div>
  );
}

export function openObject(connId: string, db: string, o: DbObject, preview: boolean) {
  const ws = useWorkspace.getState();
  const isRel = ['table', 'partitioned_table', 'view', 'materialized_view', 'foreign_table'].includes(o.kind);
  if (isRel) {
    ws.openTab({
      kind: 'table-data', title: o.name, connId, database: db, preview,
      key: `data:${connId}:${db}:${o.schema}.${o.name}`,
      params: { schema: o.schema, table: o.name, objectKind: o.kind },
    });
  } else {
    ws.openTab({
      kind: 'object', title: o.name, connId, database: db, preview,
      key: `obj:${connId}:${db}:${o.kind}:${o.oid}`,
      params: { schema: o.schema, name: o.name, objectKind: o.kind, oid: o.oid, args: o.args },
    });
  }
}

function ObjectNode({ conn, db, obj }: { conn: ConnectionConfig; db: string; obj: DbObject }) {
  const activeKey = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId)?.key);
  const isRel = ['table', 'partitioned_table', 'view', 'materialized_view', 'foreign_table'].includes(obj.kind);
  const ws = useWorkspace.getState();
  return (
    <Row
      depth={4}
      hasChildren={false}
      icon={objectIcon(obj.kind)}
      label={obj.args !== undefined ? <>{obj.name}<span className="text-subtle">({obj.args})</span></> : obj.name}
      extra={obj.estRows != null && obj.estRows > 0 ? formatCount(obj.estRows) : undefined}
      title={obj.comment ?? undefined}
      active={activeKey === `data:${conn.id}:${db}:${obj.schema}.${obj.name}` || activeKey === `obj:${conn.id}:${db}:${obj.kind}:${obj.oid}`}
      onClick={() => openObject(conn.id, db, obj, true)}
      onDoubleClick={() => openObject(conn.id, db, obj, false)}
      menu={() => [
        { label: 'Open', onSelect: () => openObject(conn.id, db, obj, false) },
        ...(isRel
          ? ([
              { label: 'Structure', onSelect: () => ws.openTab({ kind: 'structure', title: `${obj.name} · structure`, connId: conn.id, database: db, key: `struct:${conn.id}:${db}:${obj.schema}.${obj.name}`, params: { schema: obj.schema, table: obj.name, objectKind: obj.kind } }) },
              { label: 'Query in new tab', onSelect: () => ws.newQuery({ connId: conn.id, database: db, sql: `SELECT *\nFROM ${obj.schema === 'public' ? '' : obj.schema + '.'}${obj.name}\nLIMIT 100;` }) },
            ] as MenuItem[])
          : []),
        'separator',
        { label: 'Copy name', onSelect: () => navigator.clipboard.writeText(obj.name) },
      ]}
    />
  );
}
