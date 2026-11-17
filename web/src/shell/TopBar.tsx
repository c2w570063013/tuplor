import { Command, Database, FileCode2, Moon, PanelLeft, Settings, Sun, ChevronDown, Activity, Network, ShieldCheck, Archive } from 'lucide-react';
import { Button, DropdownMenu, IconButton, Kbd, type MenuItem } from '@/components/ui';
import { modKey } from '@/lib/format';
import { useConnections } from '@/stores/connections';
import { useResolvedTheme, useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { useCommandPalette } from './CommandPalette';

export function TopBar() {
  const ws = useWorkspace();
  const theme = useResolvedTheme();
  const setSettings = useSettings((s) => s.set);
  const conns = useConnections((s) => s.list);
  const state = useConnections((s) => s.state);
  const conn = conns.find((c) => c.id === ws.activeConnId);
  const openPalette = useCommandPalette((s) => s.setOpen);

  const dbItems: MenuItem[] = conns.flatMap((c) => {
    const st = state[c.id];
    if (st?.status !== 'connected' || !st.info) return [];
    return [
      { heading: c.name },
      ...st.info.databases
        .filter((d) => !d.isTemplate && d.allowConn)
        .map((d) => ({ label: d.name, icon: <Database size={13} />, onSelect: () => ws.setActiveDb(c.id, d.name) })),
    ];
  });

  const ctx = ws.activeConnId && ws.activeDb ? { connId: ws.activeConnId, database: ws.activeDb } : null;
  const toolsItems: MenuItem[] = ctx
    ? [
        { label: 'Server dashboard', icon: <Activity size={14} />, onSelect: () => ws.openTab({ kind: 'dashboard', title: `Dashboard · ${conn?.name}`, ...ctx, key: `dash:${ctx.connId}` }) },
        { label: 'ER diagram', icon: <Network size={14} />, onSelect: () => ws.openTab({ kind: 'erd', title: `ERD · ${ctx.database}`, ...ctx, key: `erd:${ctx.connId}:${ctx.database}` }) },
        { label: 'Roles & users', icon: <ShieldCheck size={14} />, onSelect: () => ws.openTab({ kind: 'roles', title: `Roles · ${conn?.name}`, ...ctx, key: `roles:${ctx.connId}` }) },
        { label: 'Backup & restore', icon: <Archive size={14} />, onSelect: () => ws.openTab({ kind: 'backup', title: `Backup · ${ctx.database}`, ...ctx, key: `backup:${ctx.connId}:${ctx.database}` }) },
      ]
    : [{ label: 'Select a database first', disabled: true }];

  return (
    <div data-titlebar className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel px-2.5">
      <IconButton label="Toggle sidebar" shortcut={`${modKey} B`} onClick={ws.toggleSidebar}><PanelLeft size={15} /></IconButton>
      <div className="flex items-center gap-2 pr-2 pl-1">
        <img src="/logo.svg" alt="" className="h-5 w-5" />
        <span className="text-[13px] font-semibold tracking-tight text-fg">Tuplor</span>
      </div>

      <DropdownMenu
        trigger={
          <button className="flex h-7 max-w-[320px] items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-xs hover:border-border-strong">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: conn?.color || 'var(--subtle)' }} />
            <span className="truncate text-fg">{conn ? conn.name : 'No connection'}</span>
            {ws.activeDb && <><span className="text-subtle">/</span><span className="truncate font-medium text-fg">{ws.activeDb}</span></>}
            <ChevronDown size={12} className="shrink-0 text-subtle" />
          </button>
        }
        items={dbItems.length ? dbItems : [{ label: 'Connect to a server in the sidebar', disabled: true }]}
      />

      <Button variant="ghost" size="sm" icon={<FileCode2 size={14} />} disabled={!ctx} onClick={() => ws.newQuery()}>New query</Button>
      <DropdownMenu trigger={<Button variant="ghost" size="sm">Tools <ChevronDown size={12} /></Button>} items={toolsItems} />

      <div className="flex-1" />

      <button
        onClick={() => openPalette(true)}
        className="flex h-7 w-64 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-xs text-subtle hover:border-border-strong hover:text-muted"
      >
        <Command size={12} />
        <span className="flex-1 text-left">Search tables, commands…</span>
        <Kbd>{modKey} K</Kbd>
      </button>
      <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}>
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </IconButton>
      <IconButton label="Settings" onClick={() => ws.openTab({ kind: 'settings', title: 'Settings', key: 'settings' })}><Settings size={15} /></IconButton>
    </div>
  );
}
