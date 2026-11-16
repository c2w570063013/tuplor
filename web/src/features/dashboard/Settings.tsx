import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FileCode2, RefreshCw, Search } from 'lucide-react';
import type { SettingRow } from '@shared/monitor';
import { Badge, Button, Dialog, IconButton, Input, Select } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';
import { cn } from '@/lib/cn';
import { quoteLiteral } from '@/lib/format';
import { Toggle } from './Activity';
import { monitorApi, mk } from './api';
import { DataTable, ErrorState, LoadingState, openInEditor, type Column } from './common';
import type { SectionProps } from './types';

const CONTEXT_HINT: Record<string, string> = {
  postmaster: 'Requires a server restart',
  sighup: 'Reload configuration (pg_reload_conf)',
  'superuser-backend': 'Set at connection start (superuser)',
  backend: 'Set at connection start',
  superuser: 'Superusers can change it per session',
  user: 'Any user can change it per session',
  internal: 'Read-only (compile-time / initdb)',
};

export function SettingsView({ connId, database, params, setParams }: SectionProps) {
  const q = useQuery({ queryKey: mk.settings(connId), queryFn: () => monitorApi.settings(connId) });
  const [search, setSearch] = useState('');
  const category: string = params.cfgCategory ?? '';
  const onlyModified: boolean = params.cfgModified ?? false;
  const [open, setOpen] = useState<SettingRow | null>(null);

  const all = q.data ?? [];
  const categories = useMemo(() => [...new Set(all.map((r) => r.category.split(' / ')[0]))].sort(), [all]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((r) => {
      if (onlyModified && !r.nonDefault && !r.pendingRestart) return false;
      if (category && !r.category.startsWith(category)) return false;
      if (s && !(r.name.toLowerCase().includes(s) || r.shortDesc.toLowerCase().includes(s) || r.setting.toLowerCase().includes(s))) return false;
      return true;
    });
  }, [all, search, category, onlyModified]);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const modified = all.filter((r) => r.nonDefault).length;
  const pending = all.filter((r) => r.pendingRestart);

  const columns: Column<SettingRow>[] = [
    {
      id: 'name', header: 'Name', sort: (r) => r.name, width: 260,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', r.nonDefault ? 'bg-accent' : 'bg-transparent')} />
          <span className={cn('font-mono text-[11.5px]', r.nonDefault ? 'font-semibold text-fg' : 'text-fg')}>{r.name}</span>
          {r.pendingRestart && <Badge tone="warning">restart pending</Badge>}
        </span>
      ),
    },
    {
      id: 'value', header: 'Value', sort: (r) => r.display, width: 180,
      cell: (r) => (
        <span className={cn('block max-w-[240px] truncate font-mono text-[11.5px]', r.nonDefault ? 'font-semibold text-accent' : 'text-fg')} title={r.setting}>
          {r.display === '' ? <span className="text-subtle">(empty)</span> : r.display}
        </span>
      ),
    },
    { id: 'unit', header: 'Unit', width: 60, cell: (r) => <span className="text-[11px] text-subtle">{r.unit ?? ''}</span> },
    { id: 'cat', header: 'Category', sort: (r) => r.category, cell: (r) => <span className="block max-w-[220px] truncate text-muted" title={r.category}>{r.category}</span> },
    { id: 'source', header: 'Source', sort: (r) => r.source, cell: (r) => <span className={r.source === 'default' ? 'text-subtle' : 'text-muted'}>{r.source}</span> },
    { id: 'desc', header: 'Description', width: '34%', className: 'max-w-0 min-w-[200px]', cell: (r) => <span className="block truncate text-muted" title={r.shortDesc}>{r.shortDesc}</span> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Input size="sm" icon={<Search size={13} />} placeholder="Search settings, values, descriptions…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-72" autoFocus />
        <Select
          size="sm"
          className="w-56"
          value={category}
          onChange={(e) => setParams({ cfgCategory: e.target.value })}
          options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
        <Toggle label="Only non-default" checked={onlyModified} onChange={(v) => setParams({ cfgModified: v })} />
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted">
          {all.length} settings · <span className="font-medium text-accent">{modified}</span> non-default
          {pending.length > 0 && <> · <span className="font-medium text-warning">{pending.length} pending restart</span></>}
          {' '}· showing {rows.length}
        </span>
        <IconButton label="Refresh" onClick={() => q.refetch()}><RefreshCw size={14} className={cn(q.isFetching && 'animate-spin')} /></IconButton>
      </div>
      {pending.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-[12px] text-warning">
          <AlertTriangle size={13} /> Changed settings waiting for a server restart: <span className="font-mono">{pending.map((p) => p.name).join(', ')}</span>
        </div>
      )}
      <DataTable
        className="flex-1"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.name}
        dense
        onRowClick={setOpen}
        defaultSort={{ id: 'name', desc: false }}
        empty={<div className="py-14 text-center text-xs text-muted">No settings match.</div>}
      />
      {open && <SettingDialog row={open} onClose={() => setOpen(null)} connId={connId} database={database} />}
    </div>
  );
}

function SettingDialog({ row, onClose, connId, database }: { row: SettingRow; onClose: () => void; connId: string; database: string }) {
  const value = row.vartype === 'string' || row.vartype === 'enum' ? quoteLiteral(row.setting) : row.unit && /B$/.test(row.unit) && !row.display.includes('.') ? quoteLiteral(row.display.replace(/\s/g, '')) : row.setting;
  const restart = row.context === 'postmaster';
  const sql = row.context === 'internal'
    ? `-- ${row.name} is read-only (${CONTEXT_HINT.internal}).`
    : `ALTER SYSTEM SET ${row.name} = ${value};\n${restart ? '-- requires a server restart to take effect' : 'SELECT pg_reload_conf();'}\n\n-- or for the current session only:\n-- SET ${row.name} = ${value};`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={<span className="font-mono">{row.name}</span>}
      description={row.category}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {row.context !== 'internal' && (
            <Button variant="primary" icon={<FileCode2 size={13} />} onClick={() => { openInEditor(connId, database, sql, `Set ${row.name}`); onClose(); }}>
              Change in SQL editor
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[12.5px]">
        <div className="text-fg">{row.shortDesc}{row.extraDesc && <span className="mt-1 block text-muted">{row.extraDesc}</span>}</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg border border-border bg-sunken p-3">
          <Prop label="Current value"><span className={cn('font-mono', row.nonDefault && 'font-semibold text-accent')}>{row.display || '(empty)'}</span></Prop>
          <Prop label="Raw setting"><span className="font-mono">{row.setting}{row.unit ? ` × ${row.unit}` : ''}</span></Prop>
          <Prop label="Default (boot)"><span className="font-mono">{row.bootVal ?? '—'}</span></Prop>
          <Prop label="Reset value"><span className="font-mono">{row.resetVal ?? '—'}</span></Prop>
          <Prop label="Source">{row.source}</Prop>
          <Prop label="Type">{row.vartype}</Prop>
          {(row.minVal != null || row.maxVal != null) && <Prop label="Range"><span className="font-mono">{row.minVal} … {row.maxVal}</span></Prop>}
          <Prop label="Context">{row.context} <span className="text-subtle">— {CONTEXT_HINT[row.context] ?? ''}</span></Prop>
          {row.enumVals && <Prop label="Allowed values" wide><span className="font-mono">{row.enumVals.join(', ')}</span></Prop>}
        </div>
        {row.pendingRestart && <div className="rounded-md bg-warning-soft px-3 py-2 text-warning">A changed value is waiting for a server restart.</div>}
        <SqlBlock sql={sql} />
      </div>
    </Dialog>
  );
}

function Prop({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="break-words text-fg">{children}</div>
    </div>
  );
}
