import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CheckCircle2, Circle, FileCode2, Puzzle, RefreshCw, RotateCcw, Search } from 'lucide-react';
import type { StatementStat, StatementsSort, StatementsStatus } from '@shared/monitor';
import { Button, IconButton, Input, Segmented, toast } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';
import { cn } from '@/lib/cn';
import { formatCount, formatDuration } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { confirm, confirmSql } from '@/stores/dialogs';
import { monitorApi, mk } from './api';
import {
  DataTable, ErrorState, errorMessage, formatPct, LoadingState, MetaItem, MiniBar, oneLine, openInEditor, QueryDialog, type Column,
} from './common';
import type { SectionProps } from './types';

export function StatementsView({ connId, database, params, setParams }: SectionProps) {
  const sort: StatementsSort = params.stmtSort ?? 'total';
  const scope: 'db' | 'all' = params.stmtScope ?? 'all';
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<StatementStat | null>(null);
  const q = useQuery({
    queryKey: mk.statements(connId, database, sort, scope),
    queryFn: () => monitorApi.statements(connId, database, sort, scope),
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.rows ?? []).filter((r) => !s || r.query.toLowerCase().includes(s) || (r.user ?? '').includes(s));
  }, [q.data, search]);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const status = q.data!.status;
  if (!status.installed || status.error) return <EnableCard status={status} connId={connId} database={database} />;

  const reset = async () => {
    if (!(await confirm({ title: 'Reset query statistics?', message: 'pg_stat_statements_reset() discards all collected statement statistics for every database on this server.', danger: true, confirmLabel: 'Reset' }))) return;
    try {
      await monitorApi.resetStatements(connId, database);
      toast.success('Statement statistics reset');
      queryClient.invalidateQueries({ queryKey: ['monitor', connId, 'statements'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const maxTotal = Math.max(1, ...rows.map((r) => r.totalMs));
  const columns: Column<StatementStat>[] = [
    {
      id: 'query', header: 'Query', width: '42%', className: 'max-w-0 min-w-[240px]',
      cell: (r) => (
        <button className="block w-full truncate text-left font-mono text-[11.5px] text-fg hover:text-accent" onClick={() => setOpen(r)} title="Show full query">
          {oneLine(r.query)}
        </button>
      ),
    },
    { id: 'calls', header: 'Calls', align: 'right', sort: (r) => r.calls, cell: (r) => formatCount(r.calls) },
    {
      id: 'total', header: 'Total time', align: 'right', sort: (r) => r.totalMs,
      cell: (r) => (
        <div className="ml-auto flex w-[120px] flex-col items-end gap-1">
          <span className="font-medium">{formatDuration(r.totalMs)}</span>
          <MiniBar value={r.totalMs} max={maxTotal} />
        </div>
      ),
    },
    { id: 'pct', header: '% of total', align: 'right', sort: (r) => r.pctTotal, cell: (r) => <span className={r.pctTotal > 25 ? 'font-medium text-warning' : 'text-muted'}>{formatPct(r.pctTotal)}</span> },
    { id: 'mean', header: 'Mean', align: 'right', sort: (r) => r.meanMs, cell: (r) => <span className={r.meanMs > 1000 ? 'font-medium text-danger' : r.meanMs > 100 ? 'text-warning' : ''}>{formatDuration(r.meanMs)}</span> },
    { id: 'max', header: 'Max', align: 'right', sort: (r) => r.maxMs, cell: (r) => <span className="text-muted">{formatDuration(r.maxMs)}</span> },
    { id: 'rows', header: 'Rows', align: 'right', sort: (r) => r.rows, cell: (r) => <span className="text-muted">{formatCount(r.rows)}</span> },
    { id: 'io', header: 'Disk reads', align: 'right', sort: (r) => r.sharedBlksRead, headerTitle: 'Shared blocks read from disk / OS cache', cell: (r) => <span className="text-muted">{formatCount(r.sharedBlksRead)}</span> },
    { id: 'hit', header: 'Cache hit', align: 'right', sort: (r) => r.hitPct ?? -1, cell: (r) => <span className={r.hitPct != null && r.hitPct < 90 ? 'text-warning' : 'text-muted'}>{formatPct(r.hitPct)}</span> },
    { id: 'user', header: 'User / DB', sort: (r) => `${r.user}/${r.database}`, cell: (r) => <span className="text-[11.5px] text-muted">{r.user ?? '—'}<span className="text-subtle"> / {r.database ?? '—'}</span></span> },
    {
      id: 'act', header: '', width: 40,
      cell: (r) => (
        <IconButton size="xs" label="Open in SQL editor" className="opacity-0 group-hover:opacity-100" onClick={() => openInEditor(connId, r.database ?? database, r.query)}>
          <FileCode2 size={13} />
        </IconButton>
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Segmented<StatementsSort>
          value={sort}
          onChange={(v) => setParams({ stmtSort: v })}
          options={[
            { value: 'total', label: 'Total time' },
            { value: 'mean', label: 'Mean time' },
            { value: 'calls', label: 'Calls' },
            { value: 'io', label: 'Disk reads' },
          ]}
        />
        <Segmented<'all' | 'db'>
          size="xs"
          value={scope}
          onChange={(v) => setParams({ stmtScope: v })}
          options={[{ value: 'all', label: 'All databases' }, { value: 'db', label: database }]}
        />
        <Input size="sm" icon={<Search size={13} />} placeholder="Filter queries…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        <div className="flex-1" />
        <span className="text-[11px] text-subtle">pg_stat_statements {status.version} · top {q.data!.rows.length}</span>
        <IconButton label="Refresh" onClick={() => q.refetch()}><RefreshCw size={14} className={cn(q.isFetching && 'animate-spin')} /></IconButton>
        <Button size="sm" variant="outline" icon={<RotateCcw size={13} />} onClick={reset}>Reset stats</Button>
      </div>
      <DataTable
        className="flex-1"
        rows={rows}
        columns={columns}
        rowKey={(r) => `${r.queryId}:${r.user}:${r.database}:${r.query.length}`}
        key={sort}
        defaultSort={{ id: sort, desc: true }}
        empty={<div className="py-14 text-center text-xs text-muted">No statements recorded yet.</div>}
      />
      {open && (
        <QueryDialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title="Statement statistics"
          sql={open.query}
          connId={connId}
          database={open.database ?? database}
          meta={
            <>
              <MetaItem label="Calls">{formatCount(open.calls)}</MetaItem>
              <MetaItem label="Total">{formatDuration(open.totalMs)}</MetaItem>
              <MetaItem label="Mean">{formatDuration(open.meanMs)}</MetaItem>
              <MetaItem label="Min / Max">{formatDuration(open.minMs)} / {formatDuration(open.maxMs)}</MetaItem>
              <MetaItem label="Stddev">{formatDuration(open.stddevMs)}</MetaItem>
              <MetaItem label="Rows">{formatCount(open.rows)}</MetaItem>
              <MetaItem label="Cache hit">{formatPct(open.hitPct)}</MetaItem>
              <MetaItem label="User / DB">{open.user ?? '—'} / {open.database ?? '—'}</MetaItem>
            </>
          }
        />
      )}
    </div>
  );
}

function EnableCard({ status, connId, database }: { status: StatementsStatus; connId: string; database: string }) {
  const [busy, setBusy] = useState(false);
  const canOneClick = status.preloaded && !status.installed && status.available;
  const install = async () => {
    if (!(await confirmSql({ title: 'Enable pg_stat_statements', sql: 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;', confirmLabel: 'Create extension', message: <>The extension will be created in <b>{database}</b>.</> }))) return;
    setBusy(true);
    try {
      await monitorApi.installStatements(connId, database);
      toast.success('pg_stat_statements enabled');
      queryClient.invalidateQueries({ queryKey: ['monitor', connId, 'statements'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    { done: status.available, title: 'Extension available', text: status.available ? 'pg_stat_statements ships with this server (contrib).' : 'Install the PostgreSQL contrib package for your platform (e.g. postgresql-contrib).' },
    {
      done: status.preloaded, title: 'Preload the library (restart required)',
      text: 'Add it to shared_preload_libraries in postgresql.conf — or run the statement below as a superuser — then restart PostgreSQL.',
      sql: status.preloaded ? undefined : `ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';\n-- if other libraries are already preloaded, keep them in the list:\n-- SHOW shared_preload_libraries;`,
    },
    { done: status.installed, title: `Create the extension in ${database}`, text: 'Run once per database from which you want to read statistics.', sql: status.installed ? undefined : 'CREATE EXTENSION pg_stat_statements;' },
  ];
  return (
    <div className="flex h-full items-start justify-center overflow-auto p-8">
      <div className="w-full max-w-[640px] rounded-xl border border-border bg-elevated p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><BarChart3 size={20} /></span>
          <div>
            <div className="text-[15px] font-semibold text-fg">Query statistics need pg_stat_statements</div>
            <div className="mt-0.5 text-[12.5px] text-muted">
              The pg_stat_statements extension tracks execution counts and timing for every normalized query — the best way to find slow and expensive queries.
            </div>
          </div>
        </div>
        {status.error && <div className="mt-4 rounded-md bg-warning-soft px-3 py-2 text-[12px] text-warning">{status.error}</div>}
        <ol className="mt-5 flex flex-col gap-4">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              {s.done ? <CheckCircle2 size={17} className="mt-px shrink-0 text-success" /> : <Circle size={17} className="mt-px shrink-0 text-subtle" />}
              <div className="min-w-0 flex-1">
                <div className={cn('text-[13px] font-medium', s.done ? 'text-muted line-through decoration-subtle/60' : 'text-fg')}>{s.title}</div>
                {!s.done && <div className="mt-0.5 text-[12px] text-muted">{s.text}</div>}
                {!s.done && s.sql && <SqlBlock sql={s.sql} className="mt-2" />}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
          {canOneClick ? (
            <Button variant="primary" icon={<Puzzle size={14} />} loading={busy} disabled={!status.canCreate} onClick={install}>
              Enable in {database}
            </Button>
          ) : (
            <span className="text-[12px] text-subtle">
              {status.preloaded ? 'Extension is not available on this server.' : 'After restarting the server, come back here to create the extension with one click.'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
