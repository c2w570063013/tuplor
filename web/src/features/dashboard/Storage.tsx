import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Copy, Eraser, FileCode2, MoreHorizontal, RefreshCw, Search, Sparkles, Table2, TableProperties, Trash2, Wrench,
} from 'lucide-react';
import type { IndexStat, MaintenanceOp, MaintenanceRequest, TableStat } from '@shared/monitor';
import { Badge, DropdownMenu, IconButton, Input, Segmented, toast, Tooltip, type MenuItem } from '@/components/ui';
import { runSql } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatDuration, quoteIdent } from '@/lib/format';
import { invalidateDb, queryClient } from '@/lib/queryClient';
import { confirmSql } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { monitorApi, mk } from './api';
import { DataTable, ErrorState, errorMessage, formatAgo, formatPct, LoadingState, MiniBar, parsePgTs, type Column } from './common';
import type { SectionProps } from './types';

type View = 'tables' | 'indexes';

export function StorageView(props: SectionProps) {
  const view: View = props.params.storageView ?? 'tables';
  const [search, setSearch] = useState('');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Segmented<View>
          value={view}
          onChange={(v) => props.setParams({ storageView: v })}
          options={[
            { value: 'tables', label: 'Tables', icon: <Table2 size={12} /> },
            { value: 'indexes', label: 'Indexes', icon: <Sparkles size={12} /> },
          ]}
        />
        <Input size="sm" icon={<Search size={13} />} placeholder={`Filter ${view}…`} value={search} onChange={(e) => setSearch(e.target.value)} className="w-60" />
        <span className="text-[11.5px] text-subtle">Database <span className="font-medium text-muted">{props.database}</span></span>
        <div className="flex-1" />
        {view === 'indexes' && <IndexFilter {...props} />}
        <IconButton
          label="Refresh"
          onClick={() => queryClient.invalidateQueries({ queryKey: view === 'tables' ? mk.tables(props.connId, props.database) : mk.indexes(props.connId, props.database) })}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {view === 'tables' ? <TablesTable {...props} search={search} /> : <IndexesTable {...props} search={search} />}
    </div>
  );
}

// ------------------------------------------------------------------ maintenance

async function runMaintenance(connId: string, db: string, req: MaintenanceRequest) {
  let sql: string;
  try {
    sql = (await monitorApi.maintenance(connId, db, { ...req, dryRun: true })).sql;
  } catch (e) {
    toast.error(errorMessage(e));
    return;
  }
  const heavy = req.op === 'VACUUM FULL' || req.op === 'REINDEX';
  const ok = await confirmSql({
    title: `${req.op} ${req.schema}.${req.name}`,
    sql,
    danger: heavy,
    confirmLabel: 'Run',
    message: req.op === 'VACUUM FULL'
      ? 'VACUUM FULL rewrites the whole table and holds an ACCESS EXCLUSIVE lock (blocks reads and writes) until it finishes.'
      : req.op === 'REINDEX'
        ? 'REINDEX rebuilds the index and blocks writes to the table while it runs. Consider REINDEX CONCURRENTLY from the SQL editor on busy systems.'
        : undefined,
  });
  if (!ok) return;
  const id = toast.loading(`Running ${req.op} on ${req.name}…`);
  try {
    const r = await monitorApi.maintenance(connId, db, req);
    toast.success(`${req.op} finished${r.durationMs != null ? ` in ${formatDuration(r.durationMs)}` : ''}`, { id });
    queryClient.invalidateQueries({ queryKey: mk.tables(connId, db) });
    queryClient.invalidateQueries({ queryKey: mk.indexes(connId, db) });
  } catch (e) {
    toast.error(errorMessage(e), { id });
  }
}

const sev = (v: number, warn: number, bad: number) => (v >= bad ? 'text-danger font-medium' : v >= warn ? 'text-warning' : 'text-fg');

function lastOf(a: string | null, b: string | null): { at: string | null; auto: boolean } {
  const ta = parsePgTs(a) ?? -1;
  const tb = parsePgTs(b) ?? -1;
  if (ta < 0 && tb < 0) return { at: null, auto: false };
  return ta >= tb ? { at: a, auto: false } : { at: b, auto: true };
}

function When({ at, auto }: { at: string | null; auto: boolean }) {
  if (!at) return <span className="text-subtle">never</span>;
  const age = Date.now() - (parsePgTs(at) ?? Date.now());
  return (
    <Tooltip content={`${auto ? 'Autovacuum daemon' : 'Manual'} · ${at}`}>
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', age > 7 * 86_400_000 ? 'text-warning' : 'text-muted')}>
        {formatAgo(at)}
        {auto && <span className="rounded bg-active px-1 text-[9.5px] text-subtle">auto</span>}
      </span>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ tables

function TablesTable({ connId, database, search }: SectionProps & { search: string }) {
  const q = useQuery({ queryKey: mk.tables(connId, database), queryFn: () => monitorApi.tables(connId, database) });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((t) => !s || `${t.schema}.${t.name}`.toLowerCase().includes(s));
  }, [q.data, search]);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const all = q.data ?? [];
  const maxSize = Math.max(1, ...all.map((t) => t.totalBytes));
  const totalSize = all.reduce((a, t) => a + t.totalBytes, 0);
  const dead = all.reduce((a, t) => a + t.deadTuples, 0);
  const needVacuum = all.filter((t) => t.deadPct >= 20 && t.deadTuples > 1000).length;

  const menu = (t: TableStat): MenuItem[] => {
    const m = (op: MaintenanceOp) => () => runMaintenance(connId, database, { op, schema: t.schema, name: t.name });
    const ws = useWorkspace.getState();
    return [
      { label: 'VACUUM', icon: <Eraser size={13} />, onSelect: m('VACUUM') },
      { label: 'VACUUM ANALYZE', icon: <Eraser size={13} />, onSelect: m('VACUUM ANALYZE') },
      { label: 'ANALYZE', icon: <Sparkles size={13} />, onSelect: m('ANALYZE') },
      'separator',
      { label: 'VACUUM FULL…', icon: <Wrench size={13} />, onSelect: m('VACUUM FULL'), danger: true },
      { label: 'REINDEX TABLE…', icon: <Wrench size={13} />, onSelect: m('REINDEX') },
      'separator',
      {
        label: 'Open data', icon: <Table2 size={13} />,
        onSelect: () => ws.openTab({ kind: 'table-data', title: t.name, connId, database, key: `data:${connId}:${database}:${t.schema}.${t.name}`, params: { schema: t.schema, table: t.name } }),
      },
      {
        label: 'Structure', icon: <TableProperties size={13} />,
        onSelect: () => ws.openTab({ kind: 'structure', title: `${t.name} · structure`, connId, database, key: `struct:${connId}:${database}:${t.schema}.${t.name}`, params: { schema: t.schema, table: t.name } }),
      },
    ];
  };

  const columns: Column<TableStat>[] = [
    {
      id: 'name', header: 'Table', sort: (t) => `${t.schema}.${t.name}`,
      cell: (t) => (
        <div className="min-w-[160px]">
          <div className="truncate font-medium text-fg"><span className="font-normal text-subtle">{t.schema}.</span>{t.name}</div>
          <MiniBar value={t.totalBytes} max={maxSize} className="mt-1 max-w-[220px]" />
        </div>
      ),
    },
    {
      id: 'size', header: 'Total size', align: 'right', sort: (t) => t.totalBytes,
      cell: (t) => (
        <Tooltip content={`Table ${formatBytes(t.tableBytes)} · Indexes ${formatBytes(t.indexBytes)} · TOAST ${formatBytes(t.toastBytes)}`}>
          <span className="font-medium">{formatBytes(t.totalBytes)}</span>
        </Tooltip>
      ),
    },
    { id: 'rows', header: 'Rows', align: 'right', sort: (t) => t.liveTuples, cell: (t) => formatCount(t.liveTuples) },
    {
      id: 'dead', header: 'Dead tuples', align: 'right', sort: (t) => t.deadPct,
      headerTitle: 'Dead tuples awaiting vacuum (share of live + dead)',
      cell: (t) => t.deadTuples === 0 ? <span className="text-subtle">0</span> : (
        <span className={t.deadTuples >= 500 ? sev(t.deadPct, 10, 20) : 'text-muted'}>{formatCount(t.deadTuples)} <span className="text-[11px] opacity-80">({formatPct(t.deadPct)})</span></span>
      ),
    },
    { id: 'seq', header: 'Seq scans', align: 'right', sort: (t) => t.seqScan, cell: (t) => formatCount(t.seqScan) },
    {
      id: 'idx', header: 'Index scans', align: 'right',
      headerTitle: 'Index scans (share of all scans that used an index — low values on large tables often mean a missing index)',
      sort: (t) => t.idxScan,
      cell: (t) => {
        const n = t.seqScan + t.idxScan;
        const p = n ? (100 * t.idxScan) / n : null;
        return (
          <span>
            {formatCount(t.idxScan)}
            {p != null && <span className={cn('ml-1 text-[11px]', t.liveTuples > 10_000 && p < 50 ? 'font-medium text-warning' : 'text-subtle')}>({p.toFixed(0)}%)</span>}
          </span>
        );
      },
    },
    {
      id: 'bloat', header: 'Bloat (est.)', align: 'right', sort: (t) => t.bloatBytes ?? -1,
      headerTitle: 'Estimated wasted space from pg_stats row widths. Requires ANALYZE; heuristic.',
      cell: (t) => t.bloatBytes == null ? <span className="text-subtle" title="Run ANALYZE to estimate">n/a</span> : t.bloatBytes < 8192 * 4 ? <span className="text-subtle">—</span> : (
        <span className={sev(t.bloatPct ?? 0, 30, 50)}>{formatBytes(t.bloatBytes)} <span className="text-[11px] opacity-80">({formatPct(t.bloatPct, 0)})</span></span>
      ),
    },
    {
      id: 'vac', header: 'Last vacuum', sort: (t) => parsePgTs(lastOf(t.lastVacuum, t.lastAutovacuum).at) ?? 0,
      cell: (t) => <When {...lastOf(t.lastVacuum, t.lastAutovacuum)} />,
    },
    {
      id: 'an', header: 'Last analyze', sort: (t) => parsePgTs(lastOf(t.lastAnalyze, t.lastAutoanalyze).at) ?? 0,
      cell: (t) => <When {...lastOf(t.lastAnalyze, t.lastAutoanalyze)} />,
    },
    {
      id: 'act', header: '', width: 44, align: 'right',
      cell: (t) => (
        <DropdownMenu align="end" items={menu(t)} trigger={<IconButton size="xs" label="Maintenance"><MoreHorizontal size={14} /></IconButton>} />
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-6 px-4 py-2.5 text-[11.5px] text-muted">
        <span><span className="font-semibold text-fg">{all.length}</span> tables</span>
        <span><span className="font-semibold text-fg">{formatBytes(totalSize)}</span> total</span>
        <span><span className="font-semibold text-fg">{formatCount(dead)}</span> dead tuples</span>
        {needVacuum > 0 && <span className="text-warning"><span className="font-semibold">{needVacuum}</span> table{needVacuum > 1 ? 's' : ''} with ≥20% dead tuples</span>}
      </div>
      <DataTable
        className="flex-1 border-t border-border"
        rows={rows}
        columns={columns}
        rowKey={(t) => `${t.schema}.${t.name}`}
        defaultSort={{ id: 'size', desc: true }}
        empty={<div className="py-14 text-center text-xs text-muted">{all.length ? 'No tables match the filter.' : 'This database has no user tables.'}</div>}
      />
    </div>
  );
}

// ------------------------------------------------------------------ indexes

type IdxFilter = 'all' | 'unused' | 'duplicate';

function IndexFilter({ params, setParams }: SectionProps) {
  return (
    <Segmented<IdxFilter>
      size="xs"
      value={params.idxFilter ?? 'all'}
      onChange={(v) => setParams({ idxFilter: v })}
      options={[{ value: 'all', label: 'All' }, { value: 'unused', label: 'Unused' }, { value: 'duplicate', label: 'Duplicates' }]}
    />
  );
}

function IndexesTable({ connId, database, search, params }: SectionProps & { search: string }) {
  const filter: IdxFilter = params.idxFilter ?? 'all';
  const q = useQuery({ queryKey: mk.indexes(connId, database), queryFn: () => monitorApi.indexes(connId, database) });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((i) => {
      if (filter === 'unused' && !i.unused) return false;
      if (filter === 'duplicate' && !i.duplicateOf.length) return false;
      return !s || `${i.schema}.${i.table}.${i.name}`.toLowerCase().includes(s);
    });
  }, [q.data, search, filter]);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const all = q.data ?? [];
  const unused = all.filter((i) => i.unused);
  const dups = all.filter((i) => i.duplicateOf.length);
  const maxSize = Math.max(1, ...all.map((i) => i.sizeBytes));

  const drop = async (i: IndexStat) => {
    const sql = `DROP INDEX CONCURRENTLY ${quoteIdent(i.schema)}.${quoteIdent(i.name)};`;
    if (!(await confirmSql({ title: `Drop index ${i.name}?`, sql, danger: true, confirmLabel: 'Drop index', message: 'CONCURRENTLY avoids blocking writes on the table while the index is dropped.' }))) return;
    try {
      await runSql(connId, database, sql);
      toast.success(`Index ${i.name} dropped`);
      invalidateDb(connId, database);
      queryClient.invalidateQueries({ queryKey: mk.indexes(connId, database) });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<IndexStat>[] = [
    {
      id: 'name', header: 'Index', sort: (i) => i.name,
      cell: (i) => (
        <div className="min-w-[180px]">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-fg">{i.name}</span>
            {i.isPrimary && <Badge tone="accent">primary</Badge>}
            {!i.isPrimary && i.isUnique && <Badge>unique</Badge>}
            {!i.isValid && <Badge tone="danger">invalid</Badge>}
          </div>
          <MiniBar value={i.sizeBytes} max={maxSize} className="mt-1 max-w-[220px]" />
        </div>
      ),
    },
    { id: 'table', header: 'Table', sort: (i) => `${i.schema}.${i.table}`, cell: (i) => <span className="text-muted"><span className="text-subtle">{i.schema}.</span>{i.table}</span> },
    { id: 'size', header: 'Size', align: 'right', sort: (i) => i.sizeBytes, cell: (i) => <span className="font-medium">{formatBytes(i.sizeBytes)}</span> },
    { id: 'scans', header: 'Scans', align: 'right', sort: (i) => i.scans, cell: (i) => <span className={i.scans === 0 ? 'text-subtle' : ''}>{formatCount(i.scans)}</span> },
    { id: 'read', header: 'Tuples read', align: 'right', sort: (i) => i.tupRead, cell: (i) => <span className="text-muted">{formatCount(i.tupRead)}</span> },
    {
      id: 'flags', header: 'Findings', sort: (i) => (i.duplicateOf.length ? 2 : i.unused ? 1 : 0),
      cell: (i) => (
        <div className="flex flex-wrap items-center gap-1">
          {i.duplicateOf.length > 0 && (
            <Tooltip content={`Same definition as ${i.duplicateOf.join(', ')}`}>
              <span><Badge tone="danger">duplicate of {i.duplicateOf[0]}{i.duplicateOf.length > 1 ? ` +${i.duplicateOf.length - 1}` : ''}</Badge></span>
            </Tooltip>
          )}
          {i.unused && (
            <Tooltip content="Never used since statistics were last reset; not backing a constraint.">
              <span><Badge tone="warning">unused</Badge></span>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: 'def', header: 'Definition', width: '30%', className: 'max-w-0 min-w-[200px]',
      cell: (i) => <span className="block truncate font-mono text-[11px] text-muted" title={i.definition}>{i.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')}</span>,
    },
    {
      id: 'act', header: '', width: 44, align: 'right',
      cell: (i) => (
        <DropdownMenu
          align="end"
          trigger={<IconButton size="xs" label="Index actions"><MoreHorizontal size={14} /></IconButton>}
          items={[
            { label: 'Copy definition', icon: <Copy size={13} />, onSelect: () => { void navigator.clipboard.writeText(i.definition + ';'); toast.success('Copied'); } },
            { label: 'Open definition in editor', icon: <FileCode2 size={13} />, onSelect: () => useWorkspace.getState().newQuery({ connId, database, sql: i.definition + ';\n' }) },
            { label: 'REINDEX…', icon: <Wrench size={13} />, onSelect: () => runMaintenance(connId, database, { op: 'REINDEX', kind: 'index', schema: i.schema, name: i.name }) },
            'separator',
            { label: 'Drop index…', icon: <Trash2 size={13} />, danger: true, disabled: i.isPrimary, onSelect: () => drop(i) },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-6 px-4 py-2.5 text-[11.5px] text-muted">
        <span><span className="font-semibold text-fg">{all.length}</span> indexes</span>
        <span><span className="font-semibold text-fg">{formatBytes(all.reduce((a, i) => a + i.sizeBytes, 0))}</span> total</span>
        <span className={unused.length ? 'text-warning' : ''}>
          <span className="font-semibold">{unused.length}</span> unused ({formatBytes(unused.reduce((a, i) => a + i.sizeBytes, 0))})
        </span>
        <span className={dups.length ? 'text-danger' : ''}><span className="font-semibold">{dups.length}</span> duplicates</span>
        {unused.length > 0 && <span className="text-subtle">Usage counts reset with statistics; check replicas before dropping.</span>}
      </div>
      <DataTable
        className="flex-1 border-t border-border"
        rows={rows}
        columns={columns}
        rowKey={(i) => `${i.schema}.${i.name}`}
        defaultSort={{ id: 'size', desc: true }}
        rowClassName={(i) => i.duplicateOf.length > 0 && 'bg-danger-soft/30'}
        empty={<div className="py-14 text-center text-xs text-muted">{all.length ? 'No indexes match.' : 'No user indexes in this database.'}</div>}
      />
    </div>
  );
}

