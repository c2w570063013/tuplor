import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, FileCode2, RefreshCw } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Spinner, toast } from '@/components/ui';
import { SqlBlock } from '@/components/SqlBlock';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { confirmSql } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { monitorApi } from './api';

// ------------------------------------------------------------------ formatting

/** Parse PostgreSQL's text timestamptz ("2026-11-17 00:47:54.97+08") into epoch ms. */
export function parsePgTs(s: string | null | undefined): number | null {
  if (!s) return null;
  let iso = s.replace(' ', 'T');
  iso = iso.replace(/([+-]\d\d)$/, '$1:00').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function formatAgo(s: string | null | undefined): string {
  const t = parsePgTs(s);
  if (t == null) return 'never';
  return `${formatSpan(Date.now() - t)} ago`;
}

/** Compact span: 450ms, 12s, 3m 05s, 4h 12m, 8d 3h. */
export function formatSpan(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatRate(n: number | null | undefined, unit = '/s'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 10) return `${n.toFixed(1)}${unit}`;
  return `${formatCount(n)}${unit}`;
}

export function formatPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 99.995 && n < 100) return '99.99%';
  return `${n.toFixed(digits)}%`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.info.message;
  return (e as Error)?.message ?? String(e);
}

// ------------------------------------------------------------------ ticking clock

let listeners = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(fn: (n: number) => void) {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => { const n = Date.now(); listeners.forEach((l) => l(n)); }, 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
  };
}

/** Current time, re-rendering every second while `live`. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (live ? subscribe(setNow) : undefined), [live]);
  return now;
}

// ------------------------------------------------------------------ states

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-xs text-muted">
      <Spinner size={14} /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const info = error instanceof ApiError ? error.info : undefined;
  return (
    <EmptyState
      icon={<AlertTriangle size={26} className="text-danger" />}
      title="Could not load data"
      description={
        <span className="flex flex-col gap-1">
          <span className="font-mono text-[11.5px] text-danger">{errorMessage(error)}</span>
          {info?.hint && <span>{info.hint}</span>}
        </span>
      }
      action={onRetry && <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} onClick={onRetry}>Retry</Button>}
    />
  );
}

// ------------------------------------------------------------------ badges

export function StateBadge({ state, waitType }: { state: string | null; waitType?: string | null }) {
  if (waitType === 'Lock') return <Badge tone="danger"><Dot />waiting on lock</Badge>;
  switch (state) {
    case 'active': return <Badge tone="success"><Dot />active</Badge>;
    case 'idle': return <Badge tone="neutral">idle</Badge>;
    case 'idle in transaction': return <Badge tone="warning"><Dot />idle in tx</Badge>;
    case 'idle in transaction (aborted)': return <Badge tone="danger"><Dot />aborted tx</Badge>;
    case null: case undefined: case '': return <Badge tone="neutral" className="opacity-70">background</Badge>;
    default: return <Badge tone="neutral">{state}</Badge>;
  }
}

function Dot() {
  return <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />;
}

/** Thin horizontal bar used inside table cells for proportions. */
export function MiniBar({ value, max, tone = 'accent', className }: { value: number; max: number; tone?: 'accent' | 'warning' | 'danger' | 'success'; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = { accent: 'bg-accent', warning: 'bg-warning', danger: 'bg-danger', success: 'bg-success' }[tone];
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-active', className)}>
      <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------ sortable table

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  className?: string;
  headerTitle?: string;
}

export type SortState = { id: string; desc: boolean };

export function DataTable<T>({
  rows, columns, rowKey, defaultSort, sort: sortProp, onSortChange, onRowClick, rowClassName, empty, className, dense,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string | number;
  defaultSort?: SortState;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  onRowClick?: (r: T) => void;
  rowClassName?: (r: T) => string | false | undefined;
  empty?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  const [localSort, setLocalSort] = useState<SortState | undefined>(defaultSort);
  const sort = sortProp ?? localSort;
  const setSort = (s: SortState) => (onSortChange ? onSortChange(s) : setLocalSort(s));

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.id);
    if (!col?.sort) return rows;
    const get = col.sort;
    const dir = sort!.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
    });
  }, [rows, columns, sort]);

  return (
    <div className={cn('min-h-0 overflow-auto', className)}>
      <table className="w-full border-separate border-spacing-0 text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              return (
                <th
                  key={c.id}
                  title={c.headerTitle}
                  style={{ width: c.width }}
                  className={cn(
                    'h-8 border-b border-border bg-grid-header px-3 text-[11px] font-medium whitespace-nowrap text-muted select-none',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.sort && 'cursor-pointer hover:text-fg',
                    active && 'text-fg',
                  )}
                  onClick={c.sort ? () => setSort({ id: c.id, desc: active ? !sort!.desc : true }) : undefined}
                >
                  <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                    {c.header}
                    {active && (sort!.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn('group', onRowClick && 'cursor-pointer', 'hover:bg-hover', rowClassName?.(r))}
            >
              {columns.map((c) => (
                <td
                  key={c.id}
                  className={cn(
                    'border-b border-grid-line px-3 align-middle whitespace-nowrap',
                    dense ? 'h-7' : 'h-8',
                    c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.className,
                  )}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (empty ?? <EmptyState title="Nothing to show" className="h-auto py-12" />)}
    </div>
  );
}

// ------------------------------------------------------------------ query viewing / actions

export function openInEditor(connId: string, database: string | null | undefined, sql: string, title?: string) {
  const ws = useWorkspace.getState();
  const id = ws.newQuery({ connId, database: database || undefined, sql, title });
  if (!id) toast.error('No database selected to open the query in');
}

export function QueryDialog({
  open, onOpenChange, title, sql, connId, database, meta,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  sql: string;
  connId: string;
  database?: string | null;
  meta?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            icon={<FileCode2 size={13} />}
            onClick={() => { openInEditor(connId, database, sql); onOpenChange(false); }}
          >
            Open in SQL editor
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {meta && <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">{meta}</div>}
        <SqlBlock sql={sql || '-- (no query text)'} className="max-h-[55vh]" />
      </div>
    </Dialog>
  );
}

export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-subtle">{label}</span>
      <span className="text-fg">{children}</span>
    </span>
  );
}

/** Cancel or terminate a backend after showing the SQL. Returns true when signalled. */
export async function signalBackend(connId: string, pid: number, action: 'cancel' | 'terminate', query?: string): Promise<boolean> {
  const fn = action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
  const ok = await confirmSql({
    title: action === 'cancel' ? `Cancel query on backend ${pid}?` : `Terminate backend ${pid}?`,
    sql: `SELECT ${fn}(${pid});`,
    danger: action === 'terminate',
    confirmLabel: action === 'cancel' ? 'Cancel query' : 'Terminate',
    message:
      action === 'cancel'
        ? 'The running statement will be cancelled; the session stays connected.'
        : <>The session will be disconnected and any open transaction rolled back.{query ? <span className="mt-1 block truncate font-mono text-[11px] text-subtle">{query.slice(0, 160)}</span> : null}</>,
  });
  if (!ok) return false;
  try {
    await monitorApi.signal(connId, pid, action);
    toast.success(action === 'cancel' ? `Cancel request sent to ${pid}` : `Backend ${pid} terminated`);
    setTimeout(() => queryClient.invalidateQueries({ queryKey: ['monitor', connId] }), 250);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}

/** Collapse whitespace for single-line previews. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
