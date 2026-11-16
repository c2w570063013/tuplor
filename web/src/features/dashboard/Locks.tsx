import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, CornerDownRight, Eye, Lock, Search, ShieldAlert, XCircle } from 'lucide-react';
import type { BlockingNode, LockInfo } from '@shared/monitor';
import { Badge, Button, IconButton, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { Toggle } from './Activity';
import { monitorApi, mk } from './api';
import {
  DataTable, ErrorState, formatSpan, LoadingState, MetaItem, oneLine, QueryDialog, signalBackend, StateBadge, useNow, type Column,
} from './common';
import type { SectionProps } from './types';

export function LocksView({ connId, database, live, intervalMs, params, setParams }: SectionProps) {
  const q = useQuery({
    queryKey: mk.locks(connId, database),
    queryFn: () => monitorApi.locks(connId, database),
    refetchInterval: live ? intervalMs : false,
    staleTime: 0,
  });
  const now = useNow(live);
  const tick = Math.max(0, now - q.dataUpdatedAt);
  const onlyWaiting: boolean = params.lockOnlyWaiting ?? false;
  const hideXid: boolean = params.lockHideXid ?? true;
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ pid: number; query: string; database: string | null; user: string | null } | null>(null);

  const locks = q.data?.locks ?? [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return locks.filter((l) => {
      if (onlyWaiting && l.granted) return false;
      if (hideXid && l.granted && (l.lockType === 'virtualxid' || l.lockType === 'transactionid')) return false;
      if (s && ![l.pid, l.relation, l.mode, l.lockType, l.user, l.query, l.database].some((v) => String(v ?? '').toLowerCase().includes(s))) return false;
      return true;
    });
  }, [locks, onlyWaiting, hideXid, search]);

  if (q.isLoading) return <LoadingState />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const waiting = locks.filter((l) => !l.granted).length;
  const columns: Column<LockInfo>[] = [
    { id: 'pid', header: 'PID', width: 72, sort: (r) => r.pid, cell: (r) => <span className="font-mono text-[11.5px]">{r.pid}</span> },
    {
      id: 'granted', header: 'Status', width: 96, sort: (r) => (r.granted ? 1 : 0),
      cell: (r) => r.granted ? <Badge tone="success">granted</Badge> : <Badge tone="danger">waiting</Badge>,
    },
    { id: 'type', header: 'Lock type', sort: (r) => r.lockType, cell: (r) => <span className="text-muted">{r.lockType}</span> },
    {
      id: 'mode', header: 'Mode', sort: (r) => r.mode,
      cell: (r) => <span className={cn('font-mono text-[11.5px]', /Exclusive/.test(r.mode) && !/Share/.test(r.mode) ? 'text-warning' : 'text-fg')}>{r.mode}</span>,
    },
    {
      id: 'target', header: 'Target', sort: (r) => r.relation ?? r.transactionId ?? r.virtualXid,
      cell: (r) => (
        <span className="font-mono text-[11.5px] text-fg">
          {r.relation ?? (r.transactionId ? `xid ${r.transactionId}` : r.virtualXid ? `vxid ${r.virtualXid}` : '—')}
          {r.page != null && <span className="text-subtle"> · page {r.page}{r.tuple != null ? ` tuple ${r.tuple}` : ''}</span>}
        </span>
      ),
    },
    { id: 'db', header: 'Database', sort: (r) => r.database, cell: (r) => r.database ?? <span className="text-subtle">—</span> },
    { id: 'user', header: 'User', sort: (r) => r.user, cell: (r) => r.user ?? <span className="text-subtle">—</span> },
    {
      id: 'wait', header: 'Waiting', align: 'right', width: 84, sort: (r) => r.waitStartAgeMs ?? -1,
      cell: (r) => r.waitStartAgeMs == null ? <span className="text-subtle">—</span>
        : <span className="font-mono text-[11.5px] text-danger">{formatSpan(r.waitStartAgeMs + tick)}</span>,
    },
    {
      id: 'query', header: 'Query', width: '30%', className: 'max-w-0 min-w-[200px]',
      cell: (r) => r.query
        ? <button className="block w-full truncate text-left font-mono text-[11.5px] hover:text-accent" onClick={() => setOpen({ pid: r.pid, query: r.query, database: r.database, user: r.user })}>{oneLine(r.query)}</button>
        : <span className="text-subtle">—</span>,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="p-4 pb-2">
        <BlockingTree
          nodes={q.data?.blocking ?? []}
          tick={tick}
          onView={(n) => setOpen({ pid: n.pid, query: n.query, database: n.database, user: n.user })}
          onSignal={(n, a) => signalBackend(connId, n.pid, a, n.query)}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <div className="text-[12.5px] font-semibold text-fg">All locks</div>
        <Input size="sm" icon={<Search size={13} />} placeholder="Filter by relation, pid, mode…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-60" />
        <Toggle label="Only waiting" checked={onlyWaiting} onChange={(v) => setParams({ lockOnlyWaiting: v })} />
        <Toggle label="Hide own transaction-id locks" checked={hideXid} onChange={(v) => setParams({ lockHideXid: v })} />
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted">
          {locks.length} locks · <span className={waiting ? 'font-medium text-danger' : ''}>{waiting} waiting</span> · showing {rows.length}
        </span>
      </div>
      <div className="mx-4 mb-4 rounded-lg border border-border">
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => `${r.pid}:${r.lockType}:${r.mode}:${r.relation}:${r.transactionId}:${r.virtualXid}:${r.page}:${r.tuple}:${r.granted}`}
          defaultSort={{ id: 'granted', desc: false }}
          dense
          empty={<div className="py-10 text-center text-xs text-muted">No locks match the filters.</div>}
        />
      </div>
      {open && (
        <QueryDialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={`Backend ${open.pid}`}
          sql={open.query}
          connId={connId}
          database={open.database ?? database}
          meta={<><MetaItem label="User">{open.user ?? '—'}</MetaItem><MetaItem label="Database">{open.database ?? '—'}</MetaItem></>}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ blocking tree

function BlockingTree({
  nodes, tick, onView, onSignal,
}: {
  nodes: BlockingNode[];
  tick: number;
  onView: (n: BlockingNode) => void;
  onSignal: (n: BlockingNode, action: 'cancel' | 'terminate') => void;
}) {
  if (!nodes.length) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-elevated px-4 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success-soft text-success"><CheckCircle2 size={16} /></span>
        <div>
          <div className="text-[12.5px] font-semibold text-fg">No blocking</div>
          <div className="text-[11.5px] text-muted">No session is currently waiting on a lock held by another session.</div>
        </div>
      </div>
    );
  }
  const byPid = new Map(nodes.map((n) => [n.pid, n]));
  const blockersOf = (n: BlockingNode) => n.blockedBy.filter((p) => byPid.has(p));
  // Longest chain depth per node; a waiter blocked by several sessions hangs under the deepest one.
  const depthMemo = new Map<number, number>();
  const depthOf = (pid: number, path = new Set<number>()): number => {
    if (depthMemo.has(pid)) return depthMemo.get(pid)!;
    if (path.has(pid)) return 0; // cycle
    path.add(pid);
    const bs = blockersOf(byPid.get(pid)!);
    const d = bs.length ? 1 + Math.max(...bs.map((b) => depthOf(b, path))) : 0;
    path.delete(pid);
    depthMemo.set(pid, d);
    return d;
  };
  const parentOf = new Map<number, number>();
  for (const n of nodes) {
    const bs = blockersOf(n);
    if (bs.length) parentOf.set(n.pid, bs.reduce((a, b) => (depthOf(b) > depthOf(a) ? b : a)));
  }
  const childrenOf = (pid: number) => nodes.filter((n) => parentOf.get(n.pid) === pid);
  const roots = nodes.filter((n) => !blockersOf(n).length);
  const seen = new Set<number>();
  const countDesc = (pid: number): number => nodes.filter((n) => n.pid !== pid && reaches(n.pid, pid, new Set())).length;
  const reaches = (from: number, target: number, path: Set<number>): boolean => {
    if (path.has(from)) return false;
    path.add(from);
    return blockersOf(byPid.get(from)!).some((b) => b === target || reaches(b, target, path));
  };

  const render = (n: BlockingNode, depth: number): ReactNode => {
    if (seen.has(n.pid)) {
      return <Row key={`${n.pid}-cycle-${depth}`} depth={depth}><span className="text-[11.5px] text-muted">pid {n.pid} (lock cycle — the deadlock detector will cancel one of them)</span></Row>;
    }
    seen.add(n.pid);
    const others = blockersOf(n).filter((b) => b !== parentOf.get(n.pid));
    const kids = childrenOf(n.pid);
    const isRoot = depth === 0;
    const blocks = countDesc(n.pid);
    return (
      <div key={`${n.pid}-${depth}`}>
        <Row depth={depth} root={isRoot}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-[11.5px] font-medium',
              isRoot ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning',
            )}>
              {isRoot ? <ShieldAlert size={12} /> : <Lock size={11} />}{n.pid}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] whitespace-nowrap">
                <span className="font-medium text-fg">{n.user ?? '—'}</span>
                <span className="text-subtle">@ {n.database ?? '—'}</span>
                <StateBadge state={n.state} waitType={isRoot ? null : 'Lock'} />
                {isRoot && blocks > 0 && <span className="text-[11px] font-medium text-danger">blocking {blocks} session{blocks > 1 ? 's' : ''}</span>}
                {!isRoot && n.queryAgeMs != null && <span className="font-mono text-[11px] text-warning">waiting {formatSpan(n.queryAgeMs + tick)}</span>}
                {isRoot && n.xactAgeMs != null && <span className="font-mono text-[11px] text-muted">tx open {formatSpan(n.xactAgeMs + tick)}</span>}
                {others.length > 0 && <span className="text-[11px] text-subtle">also blocked by {others.join(', ')}</span>}
                {n.application && <span className="text-[11px] text-subtle">{n.application}</span>}
              </div>
              <button className="block max-w-full truncate text-left font-mono text-[11px] text-muted hover:text-accent" onClick={() => onView(n)}>
                {oneLine(n.query) || '—'}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton size="sm" label="View query" onClick={() => onView(n)}><Eye size={14} /></IconButton>
              <IconButton size="sm" label="Cancel query" disabled={n.state !== 'active'} onClick={() => onSignal(n, 'cancel')}><Ban size={14} /></IconButton>
              {isRoot ? (
                <Button size="xs" variant="danger" icon={<XCircle size={12} />} onClick={() => onSignal(n, 'terminate')}>Terminate blocker</Button>
              ) : (
                <IconButton size="sm" label="Terminate session" className="hover:text-danger" onClick={() => onSignal(n, 'terminate')}><XCircle size={14} /></IconButton>
              )}
            </div>
          </div>
        </Row>
        {kids.map((k) => render(k, depth + 1))}
      </div>
    );
  };

  const tree = roots.map((r) => render(r, 0));
  // Pure cycles (no root): render remaining nodes as roots so nothing is hidden.
  const rest = nodes.filter((n) => !seen.has(n.pid)).map((n) => (seen.has(n.pid) ? null : render(n, 0)));

  return (
    <div className="overflow-hidden rounded-lg border border-danger/40 bg-elevated">
      <div className="flex items-center gap-2 border-b border-border bg-danger-soft px-4 py-2 text-[12.5px] font-semibold text-danger">
        <ShieldAlert size={14} /> Blocking chains
        <span className="font-normal text-muted">· {nodes.filter((n) => n.blockedBy.length).length} waiting, {roots.length} root blocker{roots.length === 1 ? '' : 's'}</span>
      </div>
      <div className="divide-y divide-grid-line">{tree}{rest}</div>
    </div>
  );
}

function Row({ depth, children, root }: { depth: number; children: ReactNode; root?: boolean }) {
  return (
    <div className={cn('flex items-center gap-1 py-2 pr-3', root && 'bg-bg/40')} style={{ paddingLeft: 16 + depth * 26 }}>
      {depth > 0 && <CornerDownRight size={14} className="shrink-0 text-subtle" />}
      {children}
    </div>
  );
}
