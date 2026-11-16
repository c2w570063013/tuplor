import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Clipboard, Download, Info, Maximize2, Minimize2, MessageSquareText,
  Play, Square, Table2, Workflow, ExternalLink, CornerDownRight,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { QueryError, QueryResponse, ResultSet } from '@shared/types';
import { Badge, Button, DropdownMenu, EmptyState, IconButton, Kbd, Spinner, toast, type MenuItem } from '@/components/ui';
import { DataGrid, exportRows, serializeRows, type ExportFormat, type GridColumn } from '@/components/grid';
import { cn } from '@/lib/cn';
import { formatDuration, modKey } from '@/lib/format';
import { PlanView } from '@/features/explain/PlanView';
import type { ExplainResult } from '@/features/explain/plan';
import type { StatementRange } from './sqlText';

export interface RunOutcome {
  res: QueryResponse;
  /** submitted SQL */
  sql: string;
  /** offset of `sql` in the editor model */
  base: number;
  statements: StatementRange[];
  finishedAt: number;
  /** error position mapped to the editor (1-based line/column) */
  errorPos?: { lineNumber: number; column: number };
}

export interface ExplainState {
  sql: string;
  analyze: boolean;
  result?: ExplainResult;
  error?: QueryError;
  running?: boolean;
}

interface Props {
  outcome: RunOutcome | null;
  explain: ExplainState | null;
  running: boolean;
  startedAt: number;
  onCancel: () => void;
  onGoToError: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  onOpenPlanTab: () => void;
  onRunExplainAgain: () => void;
  maxRows: number;
  /** bumps whenever a new run/explain finishes so we can pick a default tab */
  version: number;
  focusPlan: boolean;
}

const EXPORTS: { f: ExportFormat; label: string }[] = [
  { f: 'csv', label: 'CSV' },
  { f: 'tsv', label: 'TSV' },
  { f: 'json', label: 'JSON' },
  { f: 'sql', label: 'SQL INSERT statements' },
  { f: 'markdown', label: 'Markdown table' },
];

function commandLabel(r: ResultSet) {
  return r.command || 'Result';
}

export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 97);
    return () => clearInterval(t);
  }, []);
  const ms = Math.max(0, now - since);
  return <span className={cn('tabular-nums', className)}>{ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : formatDuration(ms)}</span>;
}

export function Results(p: Props) {
  const { outcome, explain, running } = p;
  const res = outcome?.res;
  const rowSets = useMemo(() => (res?.results ?? []).map((r, i) => ({ r, i })).filter((x) => x.r.fields.length > 0), [res]);
  const [active, setActive] = useState<string>('messages');

  // choose a sensible default tab whenever a run completes
  useEffect(() => {
    if (p.focusPlan && explain) { setActive('plan'); return; }
    if (!res) { setActive(explain ? 'plan' : 'messages'); return; }
    if (res.error) setActive('messages');
    else if (rowSets.length) setActive(`r${rowSets[rowSets.length - 1].i}`);
    else setActive('messages');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.version]);

  const activeSet = active.startsWith('r') ? res?.results[Number(active.slice(1))] : undefined;
  const columns: GridColumn[] = useMemo(() => activeSet?.fields.map((f) => ({ name: f.name, typeName: f.typeName })) ?? [], [activeSet]);
  const hasMessages = !!res && (res.notices.length > 0 || !!res.error);
  const tabs: { id: string; label: ReactNode; icon: ReactNode; title?: string; tone?: 'danger' | 'warning' }[] = [];
  rowSets.forEach(({ r, i }, n) => {
    tabs.push({
      id: `r${i}`,
      icon: <Table2 size={12} />,
      label: (
        <>
          {rowSets.length > 1 ? `${n + 1} · ` : ''}{commandLabel(r)} <span className="text-subtle tabular-nums">{r.truncated ? `${r.rows.length.toLocaleString()}+` : r.rows.length.toLocaleString()}</span>
        </>
      ),
      title: r.statement,
    });
  });
  if (res || !explain) {
    tabs.push({
      id: 'messages',
      icon: res?.error ? <AlertCircle size={12} /> : <MessageSquareText size={12} />,
      label: <>Messages{res && (res.notices.length > 0 || res.error) ? <span className="text-subtle"> {res.notices.length + (res.error ? 1 : 0)}</span> : null}</>,
      tone: res?.error ? 'danger' : undefined,
    });
  }
  if (explain) tabs.push({ id: 'plan', icon: <Workflow size={12} />, label: explain.analyze ? 'Plan · analyzed' : 'Plan', tone: explain.error ? 'danger' : undefined });

  const copyAs = async (f: ExportFormat) => {
    if (!activeSet) return;
    await navigator.clipboard.writeText(serializeRows(columns, activeSet.rows, f));
    toast.success(`Copied ${activeSet.rows.length.toLocaleString()} rows as ${f.toUpperCase()}`);
  };
  const exportItems: MenuItem[] = [
    { heading: 'Download' },
    ...EXPORTS.map((e) => ({ label: e.label, icon: <Download size={13} />, onSelect: () => activeSet && exportRows(columns, activeSet.rows, e.f, 'query-result') })),
    'separator',
    { heading: 'Copy to clipboard' },
    ...EXPORTS.map((e) => ({ label: e.label, icon: <Clipboard size={13} />, onSelect: () => copyAs(e.f) })),
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg">
      {/* tab strip */}
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-panel">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              title={t.title}
              className={cn(
                'relative flex shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs whitespace-nowrap',
                active === t.id ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                t.tone === 'danger' && 'text-danger',
              )}
            >
              {active === t.id && <span className="absolute inset-x-0 bottom-[-1px] h-px bg-bg" />}
              {active === t.id && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
              <span className="opacity-80">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          {activeSet && (
            <DropdownMenu
              align="end"
              items={exportItems}
              trigger={<Button variant="ghost" size="xs" icon={<Download size={12} />}>Export <ChevronDown size={11} /></Button>}
            />
          )}
          {explain && active === 'plan' && (
            <IconButton size="xs" label="Open plan in its own tab" onClick={p.onOpenPlanTab}><ExternalLink size={13} /></IconButton>
          )}
          <IconButton size="xs" label={p.maximized ? 'Restore results' : 'Maximize results'} onClick={p.onToggleMaximize}>
            {p.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
        </div>
      </div>

      {/* body */}
      <div className="relative min-h-0 flex-1">
        {active === 'plan' && explain ? (
          explain.running ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted"><Spinner size={14} /> Planning…</div>
          ) : explain.error ? (
            <div className="p-3"><ErrorCard error={explain.error} /></div>
          ) : explain.result ? (
            <PlanView result={explain.result} onRerun={p.onRunExplainAgain} />
          ) : null
        ) : activeSet ? (
          <div className="flex h-full flex-col">
            {activeSet.truncated && (
              <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-warning-soft px-3 text-[11.5px] text-warning">
                <AlertTriangle size={13} />
                Showing the first {activeSet.rows.length.toLocaleString()} rows. Raise “Max rows” in Settings or add a LIMIT / export with COPY for the full set.
              </div>
            )}
            <DataGrid columns={columns} rows={activeSet.rows} className="min-h-0 flex-1" emptyMessage="Query returned no rows" />
          </div>
        ) : res ? (
          <MessagesView outcome={outcome!} onGoToError={p.onGoToError} />
        ) : !running ? (
          <EmptyState
            icon={<Play size={22} />}
            title="Run a query to see results"
            description={
              <div className="mt-1 grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-1.5 text-left">
                <span>Run statement at cursor</span><span><Kbd>{modKey}</Kbd> <Kbd>↵</Kbd></span>
                <span>Run whole script</span><span><Kbd>⇧</Kbd> <Kbd>{modKey}</Kbd> <Kbd>↵</Kbd></span>
                <span>Explain statement</span><span><Kbd>{modKey}</Kbd> <Kbd>E</Kbd></span>
                <span>Format SQL</span><span><Kbd>⇧</Kbd> <Kbd>⌥</Kbd> <Kbd>F</Kbd></span>
                <span>Autocomplete</span><span><Kbd>⌃</Kbd> <Kbd>Space</Kbd></span>
              </div>
            }
          />
        ) : null}

        {running && (
          <div className="animate-fade-in absolute inset-0 z-10 flex items-center justify-center bg-bg/70 backdrop-blur-[1px]">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-elevated px-4 py-3 shadow-pop">
              <Spinner size={16} />
              <div className="text-xs">
                <div className="font-medium text-fg">Executing…</div>
                <Elapsed since={p.startedAt} className="text-muted" />
              </div>
              <Button size="xs" variant="danger" icon={<Square size={10} />} onClick={p.onCancel}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* footer */}
      {res && active !== 'plan' && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-subtle">
          {res.error ? (
            <span className="flex items-center gap-1 text-danger"><AlertCircle size={11} /> Error{res.error.code ? ` ${res.error.code}` : ''}</span>
          ) : (
            <span className="flex items-center gap-1 text-success"><CheckCircle2 size={11} /> Success</span>
          )}
          {activeSet && <span className="tabular-nums">{activeSet.rows.length.toLocaleString()} row{activeSet.rows.length === 1 ? '' : 's'}{activeSet.truncated ? ` (limit ${p.maxRows.toLocaleString()})` : ''} · {activeSet.fields.length} col</span>}
          {activeSet && <span className="tabular-nums">{formatDuration(activeSet.durationMs)}</span>}
          <span className="tabular-nums">{res.results.length} statement{res.results.length === 1 ? '' : 's'} · total {formatDuration(res.totalDurationMs)}</span>
          <span className="ml-auto">{new Date(outcome!.finishedAt).toLocaleTimeString()}</span>
        </div>
      )}
    </div>
  );
}

export function ErrorCard({ error, onGoToError, line }: { error: QueryError; onGoToError?: () => void; line?: { lineNumber: number; column: number } }) {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs">
      <div className="flex items-start gap-2 text-danger">
        <AlertCircle size={15} className="mt-px shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-words whitespace-pre-wrap">{error.severity && error.severity !== 'ERROR' ? `${error.severity}: ` : ''}{error.message}</span>
            {error.code && <Badge tone="danger" className="font-mono">SQLSTATE {error.code}</Badge>}
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-fg/90">
            {error.detail && (<><dt className="text-muted">Detail</dt><dd className="break-words whitespace-pre-wrap">{error.detail}</dd></>)}
            {error.hint && (<><dt className="text-muted">Hint</dt><dd className="break-words whitespace-pre-wrap">{error.hint}</dd></>)}
            {error.where && (<><dt className="text-muted">Where</dt><dd className="font-mono text-[11px] break-words whitespace-pre-wrap">{error.where}</dd></>)}
            {line && (<><dt className="text-muted">Position</dt><dd>Line {line.lineNumber}, column {line.column}</dd></>)}
            {error.statementIndex != null && (<><dt className="text-muted">Statement</dt><dd>#{error.statementIndex + 1}</dd></>)}
          </dl>
          {onGoToError && (
            <Button size="xs" variant="outline" className="mt-2.5" icon={<CornerDownRight size={11} />} onClick={onGoToError}>Show in editor</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessagesView({ outcome, onGoToError }: { outcome: RunOutcome; onGoToError: () => void }) {
  const { res, statements, sql } = outcome;
  const firstLine = (s?: string) => {
    const lines = (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => !l.startsWith('--')) ?? lines[0] ?? '';
  };
  const errPos = outcome.errorPos;
  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex flex-col gap-1.5 font-mono text-[11.5px]">
        {res.results.map((r, i) => {
          const st = r.statement ?? statements[i]?.text ?? sql;
          const affected = r.rowCount;
          return (
            <div key={i} className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-hover">
              <CheckCircle2 size={13} className="mt-px shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-muted" title={st}>{firstLine(st)}</div>
                <div className="font-sans text-[11.5px] text-fg">
                  <span className="font-medium">{r.command || 'OK'}</span>
                  {r.fields.length > 0
                    ? <> · {r.rows.length.toLocaleString()}{r.truncated ? '+' : ''} row{r.rows.length === 1 ? '' : 's'} returned</>
                    : affected != null && /INSERT|UPDATE|DELETE|MERGE|COPY|SELECT|MOVE|FETCH/.test(r.command) ? <> · {affected.toLocaleString()} row{affected === 1 ? '' : 's'} affected</> : null}
                </div>
              </div>
              <span className="shrink-0 font-sans text-subtle tabular-nums">{formatDuration(r.durationMs)}</span>
            </div>
          );
        })}
        {res.notices.map((n, i) => (
          <div key={'n' + i} className="flex items-start gap-2 rounded-md px-2 py-1">
            <Info size={13} className={cn('mt-px shrink-0', n.severity === 'WARNING' ? 'text-warning' : 'text-info')} />
            <div className="min-w-0 flex-1 font-sans break-words whitespace-pre-wrap">
              <Badge tone={n.severity === 'WARNING' ? 'warning' : 'neutral'} className="mr-1.5">{n.severity}</Badge>
              {n.message}
            </div>
          </div>
        ))}
        {res.error && (
          <div className="mt-1 font-sans">
            {res.error.statementIndex != null && statements[res.error.statementIndex] && (
              <div className="mb-1 truncate px-2 font-mono text-[11.5px] text-muted">{firstLine(statements[res.error.statementIndex].text)}</div>
            )}
            <ErrorCard error={res.error} line={errPos} onGoToError={onGoToError} />
          </div>
        )}
        {!res.results.length && !res.notices.length && !res.error && <div className="px-2 py-1 font-sans text-muted">Query executed — nothing returned.</div>}
      </div>
    </div>
  );
}
