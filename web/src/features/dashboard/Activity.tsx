import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, FileCode2, Search, Users, XCircle } from 'lucide-react';
import type { ActivitySession } from '@shared/monitor';
import { Badge, IconButton, Input, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { monitorApi, mk } from './api';
import {
  DataTable, ErrorState, formatSpan, LoadingState, MetaItem, oneLine, openInEditor, QueryDialog, signalBackend, StateBadge,
  useNow, type Column,
} from './common';
import type { SectionProps } from './types';

export function ActivityView({ connId, database, live, intervalMs, params, setParams }: SectionProps) {
  const q = useQuery({
    queryKey: mk.activity(connId),
    queryFn: () => monitorApi.activity(connId),
    refetchInterval: live ? intervalMs : false,
    staleTime: 0,
  });
  const fetchedAt = q.dataUpdatedAt;
  const now = useNow(live);
  const hideIdle: boolean = params.actHideIdle ?? true;
  const onlyDb: boolean = params.actOnlyDb ?? false;
  const showBg: boolean = params.actShowBg ?? false;
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<ActivitySession | null>(null);

  const all = q.data ?? [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((r) => {
      if (!showBg && r.backendType !== 'client backend') return false;
      if (hideIdle && r.state === 'idle') return false;
      if (onlyDb && r.database !== database) return false;
      if (s && ![r.pid, r.user, r.database, r.application, r.client, r.query, r.state, r.waitEvent].some((v) => String(v ?? '').toLowerCase().includes(s))) return false;
      return true;
    });
  }, [all, search, hideIdle, onlyDb, showBg, database]);

  const elapsed = (base: number | null) => (base == null ? null : base + Math.max(0, now - fetchedAt));
  const clientCount = all.filter((r) => r.backendType === 'client backend').length;
  const activeCount = all.filter((r) => r.state === 'active' && r.backendType === 'client backend').length;
  const waitingCount = all.filter((r) => r.waitEventType === 'Lock').length;

  const columns: Column<ActivitySession>[] = [
    {
      id: 'pid', header: 'PID', width: 84, sort: (r) => r.pid,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px]">
          {r.pid}
          {r.isSelf && <Badge tone="accent">you</Badge>}
        </span>
      ),
    },
    { id: 'user', header: 'User', sort: (r) => r.user, cell: (r) => <span className="text-fg">{r.user ?? <span className="text-subtle">—</span>}</span> },
    { id: 'db', header: 'Database', sort: (r) => r.database, cell: (r) => r.database ?? <span className="text-subtle">—</span> },
    {
      id: 'app', header: 'Application', sort: (r) => r.application, className: 'max-w-0 min-w-[90px] w-[11%]',
      cell: (r) => <span className="block truncate text-muted" title={r.application}>{r.application || (r.backendType !== 'client backend' ? r.backendType : '—')}</span>,
    },
    { id: 'client', header: 'Client', sort: (r) => r.client, className: 'max-w-0 min-w-[80px] w-[9%]', cell: (r) => <span className="block truncate font-mono text-[11px] text-muted" title={r.client ?? ''}>{r.client ?? '—'}</span> },
    { id: 'state', header: 'State', sort: (r) => (r.waitEventType === 'Lock' ? 'a' : r.state ?? 'z'), cell: (r) => <StateBadge state={r.state} waitType={r.waitEventType} /> },
    {
      id: 'wait', header: 'Wait event', sort: (r) => r.waitEvent, className: 'max-w-0 min-w-[90px] w-[10%]',
      cell: (r) => r.waitEvent
        ? <span className={cn('block truncate text-[11.5px]', r.waitEventType === 'Lock' ? 'text-danger' : 'text-muted')} title={`${r.waitEventType}: ${r.waitEvent}`}>{r.waitEventType}: {r.waitEvent}</span>
        : <span className="text-subtle">—</span>,
    },
    {
      id: 'dur', header: 'Duration', align: 'right', width: 96,
      headerTitle: 'Time since the current query started (transaction age for idle-in-transaction sessions)',
      sort: (r) => durationOf(r),
      cell: (r) => {
        const isTx = r.state?.startsWith('idle in transaction');
        const base = isTx ? r.xactAgeMs : r.state === 'active' ? r.queryAgeMs : r.queryAgeMs;
        const v = r.state === 'active' || isTx ? elapsed(base) : base;
        const ms = v ?? 0;
        return (
          <span className={cn(
            'font-mono text-[11.5px] tabular-nums',
            r.state === 'idle' ? 'text-subtle' : ms > 60_000 ? 'font-semibold text-danger' : ms > 5_000 ? 'text-warning' : 'text-fg',
          )}>
            {v == null ? '—' : formatSpan(v)}
          </span>
        );
      },
    },
    {
      id: 'query', header: 'Query', width: '36%', className: 'max-w-0 min-w-[160px]',
      cell: (r) => r.query
        ? <button className="block w-full truncate text-left font-mono text-[11.5px] text-fg hover:text-accent" title="Show full query" onClick={() => setOpen(r)}>
            {oneLine(r.query)}
          </button>
        : <span className="text-subtle">—</span>,
    },
    {
      id: 'actions', header: '', width: 92, align: 'right',
      cell: (r) => r.isSelf || r.backendType !== 'client backend' ? null : (
        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton size="xs" label="Open query in editor" disabled={!r.query} onClick={() => openInEditor(connId, r.database ?? database, r.query, `Query · pid ${r.pid}`)}>
            <FileCode2 size={13} />
          </IconButton>
          <IconButton size="xs" label="Cancel query" disabled={r.state !== 'active'} onClick={() => signalBackend(connId, r.pid, 'cancel', r.query)}>
            <Ban size={13} />
          </IconButton>
          <IconButton size="xs" label="Terminate session" className="hover:text-danger" onClick={() => signalBackend(connId, r.pid, 'terminate', r.query)}>
            <XCircle size={13} />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Input size="sm" icon={<Search size={13} />} placeholder="Filter by pid, user, query…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-64" />
        <Toggle label="Hide idle" checked={hideIdle} onChange={(v) => setParams({ actHideIdle: v })} />
        <Toggle label={`Only ${database}`} checked={onlyDb} onChange={(v) => setParams({ actOnlyDb: v })} />
        <Toggle label="Background processes" checked={showBg} onChange={(v) => setParams({ actShowBg: v })} />
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-[11.5px] text-muted">
          <span className="inline-flex items-center gap-1"><Users size={12} /> {clientCount} sessions</span>
          <span><span className="font-medium text-success">{activeCount}</span> active</span>
          {waitingCount > 0 && <span><span className="font-medium text-danger">{waitingCount}</span> waiting on locks</span>}
          <span className="text-subtle">showing {rows.length}</span>
        </div>
      </div>
      {q.isLoading ? <LoadingState /> : q.error && !q.data ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <DataTable
          className="flex-1"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.pid}
          defaultSort={{ id: 'dur', desc: true }}
          rowClassName={(r) => r.waitEventType === 'Lock' && 'bg-danger-soft/40'}
          empty={
            <div className="py-14 text-center text-xs text-muted">
              No sessions match.{hideIdle && ' Idle sessions are hidden.'}
            </div>
          }
        />
      )}
      {open && (
        <QueryDialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={`Backend ${open.pid}`}
          sql={open.query}
          connId={connId}
          database={open.database ?? database}
          meta={
            <>
              <MetaItem label="User">{open.user ?? '—'}</MetaItem>
              <MetaItem label="Database">{open.database ?? '—'}</MetaItem>
              <MetaItem label="Application">{open.application || '—'}</MetaItem>
              <MetaItem label="Client">{open.client ?? '—'}</MetaItem>
              <MetaItem label="State"><StateBadge state={open.state} waitType={open.waitEventType} /></MetaItem>
              <MetaItem label="Query started">{open.queryStart ?? '—'}</MetaItem>
              {open.blockedBy.length > 0 && <MetaItem label="Blocked by">{open.blockedBy.join(', ')}</MetaItem>}
            </>
          }
        />
      )}
    </div>
  );
}

function durationOf(r: ActivitySession): number {
  if (r.state?.startsWith('idle in transaction')) return r.xactAgeMs ?? -1;
  if (r.state === 'active') return r.queryAgeMs ?? -1;
  return -1; // idle sessions sort last
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted select-none hover:text-fg">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
