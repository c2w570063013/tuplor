import { Command as Cmdk } from 'cmdk';
import { useQuery } from '@tanstack/react-query';
import { Database, FileCode2, Moon, Plus, Settings, Activity, Network, ShieldCheck, Archive, PanelLeft } from 'lucide-react';
import { create } from 'zustand';
import type { DbObject, DbObjectKind } from '@shared/types';
import { Kbd } from '@/components/ui';
import { runSql } from '@/lib/api';
import { modKey } from '@/lib/format';
import { useConnections } from '@/stores/connections';
import { useSettings, resolvedTheme } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { openObject, objectIcon } from '@/features/explorer';
import { useConnectionDialog } from '@/features/connections/ConnectionDialog';
import { useCommands, type Command } from './commands';

export const useCommandPalette = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

const hasDb = () => !!useWorkspace.getState().activeConnId && !!useWorkspace.getState().activeDb;
const ctx = () => {
  const s = useWorkspace.getState();
  return { connId: s.activeConnId!, database: s.activeDb! };
};
const connName = () => useConnections.getState().get(useWorkspace.getState().activeConnId ?? undefined)?.name ?? '';

const BUILTIN: Command[] = [
  { id: 'query.new', title: 'New query', group: 'General', icon: <FileCode2 size={14} />, shortcut: 'Alt N', when: hasDb, run: () => useWorkspace.getState().newQuery() },
  { id: 'conn.new', title: 'New connection…', group: 'General', icon: <Plus size={14} />, run: () => useConnectionDialog.getState().show() },
  { id: 'view.sidebar', title: 'Toggle sidebar', group: 'General', icon: <PanelLeft size={14} />, shortcut: `${modKey} B`, run: () => useWorkspace.getState().toggleSidebar() },
  {
    id: 'view.theme', title: 'Toggle dark / light theme', group: 'General', icon: <Moon size={14} />,
    run: () => { const s = useSettings.getState(); s.set({ theme: resolvedTheme(s.theme) === 'dark' ? 'light' : 'dark' }); },
  },
  { id: 'app.settings', title: 'Settings', group: 'General', icon: <Settings size={14} />, run: () => useWorkspace.getState().openTab({ kind: 'settings', title: 'Settings', key: 'settings' }) },
  { id: 'tools.dashboard', title: 'Server dashboard', group: 'Tools', icon: <Activity size={14} />, when: hasDb, run: () => useWorkspace.getState().openTab({ kind: 'dashboard', title: `Dashboard · ${connName()}`, ...ctx(), key: `dash:${ctx().connId}` }) },
  { id: 'tools.erd', title: 'ER diagram', group: 'Tools', icon: <Network size={14} />, when: hasDb, run: () => useWorkspace.getState().openTab({ kind: 'erd', title: `ERD · ${ctx().database}`, ...ctx(), key: `erd:${ctx().connId}:${ctx().database}` }) },
  { id: 'tools.roles', title: 'Roles & users', group: 'Tools', icon: <ShieldCheck size={14} />, when: hasDb, run: () => useWorkspace.getState().openTab({ kind: 'roles', title: `Roles · ${connName()}`, ...ctx(), key: `roles:${ctx().connId}` }) },
  { id: 'tools.backup', title: 'Backup & restore', group: 'Tools', icon: <Archive size={14} />, when: hasDb, run: () => useWorkspace.getState().openTab({ kind: 'backup', title: `Backup · ${ctx().database}`, ...ctx(), key: `backup:${ctx().connId}:${ctx().database}` }) },
];

function useAllObjects(connId: string | null, db: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['palette-objects', connId, db],
    enabled: enabled && !!connId && !!db,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await runSql(connId!, db!, `
        SELECT c.oid::int, n.nspname, c.relname,
               CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view'
                              WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' END
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
           AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
         ORDER BY n.nspname = 'public' DESC, c.relname LIMIT 5000`);
      return r.rows.map(([oid, schema, name, kind]) => ({ oid, schema, name, kind }) as DbObject);
    },
  });
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const activeConnId = useWorkspace((s) => s.activeConnId);
  const activeDb = useWorkspace((s) => s.activeDb);
  const connected = useConnections((s) => (activeConnId ? s.state[activeConnId]?.status === 'connected' : false));
  const conns = useConnections((s) => s.list);
  const extra = useCommands((s) => s.commands);
  const objs = useAllObjects(activeConnId, activeDb, open && connected);

  if (!open) return null;
  const run = (fn: () => void) => { setOpen(false); setTimeout(fn, 0); };
  const commands = [...BUILTIN, ...Object.values(extra)].filter((c) => !c.when || c.when());
  const groups = [...new Set(commands.map((c) => c.group ?? 'Commands'))];

  return (
    <div className="animate-fade-in fixed inset-0 z-[80] flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <Cmdk
        label="Command palette"
        loop
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="animate-pop-in w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-elevated shadow-pop"
      >
        <Cmdk.Input autoFocus placeholder="Type a command or search tables…" className="h-12 w-full border-b border-border bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-subtle" />
        <Cmdk.List className="max-h-[420px] overflow-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
          <Cmdk.Empty className="py-8 text-center text-xs text-subtle">No results</Cmdk.Empty>
          {groups.map((g) => (
            <Cmdk.Group key={g} heading={g}>
              {commands.filter((c) => (c.group ?? 'Commands') === g).map((c) => (
                <Item key={c.id} value={`${c.title} ${c.keywords?.join(' ') ?? ''}`} onSelect={() => run(c.run)} icon={c.icon} shortcut={c.shortcut}>{c.title}</Item>
              ))}
            </Cmdk.Group>
          ))}
          {conns.length > 0 && (
            <Cmdk.Group heading="Connections">
              {conns.map((c) => (
                <Item
                  key={c.id}
                  value={`connect ${c.name} ${c.host}`}
                  icon={<Database size={14} style={{ color: c.color }} />}
                  onSelect={() => run(async () => {
                    const info = await useConnections.getState().connect(c.id).catch(() => undefined);
                    if (info) useWorkspace.getState().setActiveDb(c.id, c.database);
                  })}
                >
                  {c.name} <span className="text-subtle">{c.host}</span>
                </Item>
              ))}
            </Cmdk.Group>
          )}
          {objs.data && objs.data.length > 0 && (
            <Cmdk.Group heading={`Tables & views in ${activeDb}`}>
              {objs.data.map((o) => (
                <Item
                  key={o.oid}
                  value={`${o.schema}.${o.name}`}
                  icon={objectIcon(o.kind as DbObjectKind)}
                  onSelect={() => run(() => openObject(activeConnId!, activeDb!, o, false))}
                >
                  {o.name} {o.schema !== 'public' && <span className="text-subtle">{o.schema}</span>}
                </Item>
              ))}
            </Cmdk.Group>
          )}
        </Cmdk.List>
      </Cmdk>
    </div>
  );
}

function Item({ children, icon, shortcut, value, onSelect }: { children: React.ReactNode; icon?: React.ReactNode; shortcut?: string; value: string; onSelect: () => void }) {
  return (
    <Cmdk.Item
      value={value}
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-fg data-[selected=true]:bg-accent-soft"
    >
      <span className="flex w-4 justify-center text-muted">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </Cmdk.Item>
  );
}
