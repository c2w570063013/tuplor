import {
  AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronRight, Copy, Filter, Flame, GitMerge, Hash, Layers, ListTree, RefreshCw,
  RotateCcw, ScanLine, Sigma, Table2, Workflow, Braces, FileText, type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Badge, IconButton, Segmented, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { bufferText, formatBlocks, formatMs, formatRows, planToText, type ExplainResult, type PlanNode } from './plan';

type Metric = 'time' | 'cost' | 'buffers';
type View = 'tree' | 'text' | 'json';

function iconFor(type: string): LucideIcon {
  if (/Join|Nested Loop/.test(type)) return GitMerge;
  if (/Index/.test(type)) return ListTree;
  if (/Scan/.test(type)) return /Seq/.test(type) ? ScanLine : Table2;
  if (/Sort/.test(type)) return ArrowDownUp;
  if (/Aggregate|Group|WindowAgg/.test(type)) return Sigma;
  if (/Hash/.test(type)) return Hash;
  if (/Gather|Append|Union|Subquery|CTE/.test(type)) return Layers;
  if (/Limit|Unique|Result/.test(type)) return Filter;
  if (/Insert|Update|Delete|Merge|ModifyTable/.test(type)) return Workflow;
  return Workflow;
}

function pctOf(n: PlanNode, m: Metric) {
  return m === 'time' ? n.exclTimePct : m === 'cost' ? n.exclCostPct : n.exclBlocksPct;
}

function heatClass(pct: number) {
  if (pct >= 40) return { bar: 'bg-danger', text: 'text-danger', edge: 'border-l-danger' };
  if (pct >= 15) return { bar: 'bg-warning', text: 'text-warning', edge: 'border-l-warning' };
  if (pct >= 4) return { bar: 'bg-accent', text: 'text-fg', edge: 'border-l-accent/60' };
  return { bar: 'bg-border-strong', text: 'text-muted', edge: 'border-l-transparent' };
}

export function PlanView({ result, onRerun, className }: { result: ExplainResult; onRerun?: () => void; className?: string }) {
  const [metric, setMetric] = useState<Metric>(result.analyzed ? 'time' : 'cost');
  const [view, setView] = useState<View>('tree');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const hottest = useMemo(() => [...result.nodes].sort((a, b) => pctOf(b, metric) - pctOf(a, metric))[0], [result, metric]);
  const [selectedId, setSelectedId] = useState<number>(() => hottest?.id ?? 0);
  const selected = result.nodes[selectedId] ?? result.root;
  const misestimates = result.nodes.filter((n) => n.estFactor >= 10);
  const text = useMemo(() => planToText(result), [result]);
  const json = useMemo(() => JSON.stringify(typeof result.raw === 'string' ? JSON.parse(result.raw) : result.raw, null, 2), [result]);
  const [copied, setCopied] = useState(false);

  const visible = useMemo(() => {
    const out: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      out.push(n);
      if (!collapsed.has(n.id)) n.children.forEach(walk);
    };
    walk(result.root);
    return out;
  }, [result, collapsed]);

  const toggle = (id: number) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const rootRaw = result.root.raw;
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-bg', className)}>
      {/* summary */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-[11.5px]">
        {result.analyzed ? (
          <Stat label="Execution" value={formatMs(result.executionTime ?? result.totalTime)} strong />
        ) : (
          <Badge tone="neutral">Estimate only</Badge>
        )}
        {result.planningTime != null && <Stat label="Planning" value={formatMs(result.planningTime)} />}
        <Stat label="Cost" value={result.totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
        <Stat label="Rows" value={result.analyzed ? formatRows(result.root.actualRowsTotal ?? 0) : `~${formatRows(rootRaw['Plan Rows'] ?? 0)}`} />
        {result.totalBlocks > 0 && (
          <Stat label="Buffers" value={`${formatBlocks(result.totalBlocks)}`} title={bufferText(rootRaw)} />
        )}
        {result.rolledBack && <Badge tone="warning"><RotateCcw size={10} className="mr-1" />rolled back</Badge>}
        {hottest && pctOf(hottest, metric) > 0 && (
          <button onClick={() => setSelectedId(hottest.id)} className="flex items-center gap-1 rounded px-1 text-danger hover:bg-danger-soft">
            <Flame size={12} /> {hottest.type} · {pctOf(hottest, metric).toFixed(0)}%
          </button>
        )}
        {misestimates.length > 0 && (
          <Tooltip content="Nodes where actual rows differ from the planner's estimate by 10× or more. Consider ANALYZE or extended statistics.">
            <button onClick={() => setSelectedId(misestimates[0].id)} className="flex items-center gap-1 rounded px-1 text-warning hover:bg-warning-soft">
              <AlertTriangle size={12} /> {misestimates.length} misestimate{misestimates.length === 1 ? '' : 's'}
            </button>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {view === 'tree' && (
            <Segmented
              size="xs"
              value={metric}
              onChange={setMetric}
              options={[
                ...(result.analyzed ? [{ value: 'time' as Metric, label: 'Time' }] : []),
                { value: 'cost' as Metric, label: 'Cost' },
                ...(result.totalBlocks > 0 ? [{ value: 'buffers' as Metric, label: 'Buffers' }] : []),
              ]}
            />
          )}
          <Segmented
            size="xs"
            value={view}
            onChange={setView}
            options={[
              { value: 'tree', label: 'Tree', icon: <ListTree size={11} /> },
              { value: 'text', label: 'Text', icon: <FileText size={11} /> },
              { value: 'json', label: 'JSON', icon: <Braces size={11} /> },
            ]}
          />
          <IconButton
            size="xs"
            label={view === 'json' ? 'Copy JSON' : 'Copy plan as text'}
            onClick={() => {
              navigator.clipboard.writeText(view === 'json' ? json : text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </IconButton>
          {onRerun && <IconButton size="xs" label="Run again" onClick={onRerun}><RefreshCw size={12} /></IconButton>}
        </div>
      </div>

      {view !== 'tree' ? (
        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-fg">{view === 'json' ? json : text}</pre>
      ) : (
        <Group orientation="horizontal" className="min-h-0 flex-1">
          <Panel minSize="35%" defaultSize="70%">
            <div className="h-full overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-[1] bg-grid-header text-[10.5px] tracking-wide text-subtle uppercase">
                  <tr className="border-b border-border">
                    <th className="px-2 py-1.5 text-left font-medium">Operation</th>
                    <th className="w-[150px] px-2 py-1.5 text-left font-medium whitespace-nowrap">{metric === 'time' ? 'Self time' : metric === 'cost' ? 'Self cost' : 'Self buffers'}</th>
                    <th className="w-[130px] px-2 py-1.5 text-right font-medium whitespace-nowrap">{result.analyzed ? 'Rows act / est' : 'Est. rows'}</th>
                    {result.analyzed && <th className="w-[56px] px-2 py-1.5 text-right font-medium whitespace-nowrap">Loops</th>}
                    {result.analyzed && metric !== 'time' && <th className="w-[80px] px-2 py-1.5 text-right font-medium whitespace-nowrap">Time</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((n) => (
                    <PlanRow
                      key={n.id}
                      n={n}
                      metric={metric}
                      analyzed={result.analyzed}
                      selected={n.id === selected.id}
                      collapsed={collapsed.has(n.id)}
                      onToggle={() => toggle(n.id)}
                      onSelect={() => setSelectedId(n.id)}
                    />
                  ))}
                </tbody>
              </table>
              {result.triggers.length > 0 && (
                <div className="border-t border-border px-3 py-2 text-xs text-muted">
                  {result.triggers.map((t, i) => (
                    <div key={i}>Trigger <span className="text-fg">{t.name}</span>{t.relation ? ` on ${t.relation}` : ''}: {formatMs(t.time)} · {t.calls} calls</div>
                  ))}
                </div>
              )}
            </div>
          </Panel>
          <Separator />
          <Panel minSize="20%" defaultSize="30%">
            <NodeDetail n={selected} result={result} />
          </Panel>
        </Group>
      )}
    </div>
  );
}

function Stat({ label, value, strong, title }: { label: string; value: ReactNode; strong?: boolean; title?: string }) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="text-subtle">{label}</span>
      <span className={cn('tabular-nums', strong ? 'font-semibold text-fg' : 'text-fg')}>{value}</span>
    </span>
  );
}

function PlanRow({ n, metric, analyzed, selected, collapsed, onToggle, onSelect }: {
  n: PlanNode; metric: Metric; analyzed: boolean; selected: boolean; collapsed: boolean; onToggle: () => void; onSelect: () => void;
}) {
  const pct = pctOf(n, metric);
  const heat = heatClass(pct);
  const Icon = iconFor(n.type);
  const value = metric === 'time' ? formatMs(n.exclTime) : metric === 'cost' ? n.exclCost.toLocaleString(undefined, { maximumFractionDigits: 1 }) : formatBlocks(n.exclBlocks);
  const rel = n.raw['Parent Relationship'];
  return (
    <tr
      onClick={onSelect}
      className={cn(
        'cursor-default border-b border-l-2 border-grid-line align-top',
        heat.edge,
        selected ? 'bg-selection' : 'hover:bg-hover',
        n.neverExecuted && 'opacity-50',
      )}
    >
      <td className="py-1 pr-2">
        <div className="flex items-start" style={{ paddingLeft: 6 + n.depth * 16 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={cn('mt-0.5 mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg', !n.children.length && 'invisible')}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <Icon size={13} className={cn('mt-0.5 mr-1.5 shrink-0', heat.text === 'text-muted' ? 'text-subtle' : heat.text)} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium text-fg">{n.type}</span>
              {n.title && <span className="text-muted">{n.title}</span>}
              {rel && (rel === 'InitPlan' || rel === 'SubPlan') && <Badge tone="neutral">{rel}</Badge>}
              {n.neverExecuted && <Badge tone="neutral">never executed</Badge>}
              {collapsed && n.children.length > 0 && <span className="text-subtle">· {countDescendants(n)} hidden</span>}
            </div>
            {n.hint && <div className="max-w-[560px] truncate font-mono text-[10.5px] text-subtle" title={n.hint}>{n.hint}</div>}
          </div>
        </div>
      </td>
      <td className="px-2 py-1 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-active">
            <div className={cn('h-full rounded-full', heat.bar)} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%` }} />
          </div>
          <span className={cn('tabular-nums', heat.text)}>{value}</span>
          <span className="text-[10.5px] text-subtle tabular-nums">{pct >= 0.5 ? `${pct.toFixed(0)}%` : ''}</span>
        </div>
      </td>
      <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
        {analyzed ? (
          <div className="flex items-center justify-end gap-1.5">
            <EstBadge n={n} />
            <span className="text-fg">{formatRows(n.actualRows ?? 0)}</span>
            <span className="text-subtle">/ {formatRows(n.planRows)}</span>
          </div>
        ) : (
          <span className="text-fg">{formatRows(n.planRows)}</span>
        )}
      </td>
      {analyzed && <td className="px-2 py-1 text-right text-muted tabular-nums">{n.loops > 1 ? n.loops.toLocaleString() : n.loops}</td>}
      {analyzed && metric !== 'time' && <td className="px-2 py-1 text-right text-muted tabular-nums">{formatMs(n.exclTime)}</td>}
    </tr>
  );
}

function countDescendants(n: PlanNode): number {
  return n.children.reduce((a, c) => a + 1 + countDescendants(c), 0);
}

function EstBadge({ n }: { n: PlanNode }) {
  if (n.estDir === 'ok' || n.neverExecuted) return null;
  const f = n.estFactor;
  const label = f >= 1000 ? `${formatRows(f)}×` : `${f.toFixed(f < 10 ? 1 : 0)}×`;
  const severe = f >= 10;
  return (
    <Tooltip content={`Planner estimated ${n.planRows.toLocaleString()} rows per loop, actual ${(n.actualRows ?? 0).toLocaleString()} — ${n.estDir === 'under' ? 'under' : 'over'}-estimated ${label}`}>
      <span className={cn('inline-flex items-center rounded px-1 text-[10px] font-medium', severe ? 'bg-warning-soft text-warning' : 'text-subtle')}>
        {n.estDir === 'under' ? '↑' : '↓'}{label}
      </span>
    </Tooltip>
  );
}

const SHOWN = new Set([
  'Node Type', 'Plans', 'Parent Relationship', 'Relation Name', 'Schema', 'Alias', 'Index Name', 'Startup Cost', 'Total Cost', 'Plan Rows',
  'Plan Width', 'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops', 'Output', 'Shared Hit Blocks', 'Shared Read Blocks',
  'Shared Dirtied Blocks', 'Shared Written Blocks', 'Local Hit Blocks', 'Local Read Blocks', 'Local Dirtied Blocks', 'Local Written Blocks',
  'Temp Read Blocks', 'Temp Written Blocks', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Index Cond', 'Recheck Cond', 'Filter', 'One-Time Filter',
  'TID Cond', 'Rows Removed by Filter', 'Rows Removed by Join Filter', 'Rows Removed by Index Recheck', 'Sort Key', 'Group Key', 'Parallel Aware',
  'Async Capable', 'Disabled', 'Shared I/O Read Time', 'Shared I/O Write Time', 'I/O Read Time', 'I/O Write Time',
]);

function NodeDetail({ n, result }: { n: PlanNode; result: ExplainResult }) {
  const r = n.raw;
  const Icon = iconFor(n.type);
  const section = (title: string, items: [string, ReactNode | undefined | null][]) => {
    const filtered = items.filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!filtered.length) return null;
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-[10.5px] font-medium tracking-wide text-subtle uppercase">{title}</div>
        <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-0.5 text-xs">
          {filtered.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words text-fg tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  };
  const mono = (v: unknown) => (v == null ? null : <span className="font-mono text-[11px]">{Array.isArray(v) ? v.join(', ') : String(v)}</span>);
  const other = Object.entries(r).filter(([k, v]) => !SHOWN.has(k) && v !== false && v !== null && !(typeof v === 'number' && v === 0 && /Blocks|Usage/.test(k)));
  return (
    <div className="h-full overflow-auto bg-panel">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Icon size={15} className="text-accent" />
          <span className="text-sm font-semibold text-fg">{n.type}</span>
        </div>
        {n.title && <div className="mt-0.5 text-xs text-muted">{n.title}</div>}
        {n.estFactor >= 10 && (
          <div className="mt-2 flex gap-1.5 rounded-md bg-warning-soft p-2 text-[11.5px] text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>
              Row estimate is off by {n.estFactor >= 1000 ? formatRows(n.estFactor) : n.estFactor.toFixed(0)}× ({n.estDir}-estimate). Stale statistics or correlated
              columns can mislead the planner — try <code className="font-mono">ANALYZE {r['Relation Name'] ?? ''}</code> or extended statistics.
            </span>
          </div>
        )}
        {n.rowsRemoved != null && n.actualRows != null && n.rowsRemoved > (n.actualRows ?? 0) * 10 && n.rowsRemoved > 1000 && (
          <div className="mt-2 flex gap-1.5 rounded-md bg-accent-soft p-2 text-[11.5px] text-accent">
            <Filter size={13} className="mt-px shrink-0" />
            <span>Filter discarded {formatRows(n.rowsRemoved * n.loops)} rows to keep {formatRows(n.actualRowsTotal ?? 0)} — an index on the filtered columns may help.</span>
          </div>
        )}
      </div>
      {result.analyzed && section('Timing', [
        ['Self time', <>{formatMs(n.exclTime)} <span className="text-subtle">({n.exclTimePct.toFixed(1)}%)</span></>],
        ['Total time', formatMs(n.inclTime)],
        ['Startup / total', `${r['Actual Startup Time']} … ${r['Actual Total Time']} ms per loop`],
        ['Loops', n.loops.toLocaleString()],
      ])}
      {section('Rows', [
        ['Estimated', `${(r['Plan Rows'] ?? 0).toLocaleString()} per loop`],
        ['Actual', result.analyzed ? `${(n.actualRows ?? 0).toLocaleString()} per loop · ${(n.actualRowsTotal ?? 0).toLocaleString()} total` : undefined],
        ['Estimate accuracy', result.analyzed && !n.neverExecuted ? (n.estDir === 'ok' ? 'good' : `${n.estFactor.toFixed(1)}× ${n.estDir}-estimate`) : undefined],
        ['Removed by filter', r['Rows Removed by Filter']?.toLocaleString()],
        ['Removed by join filter', r['Rows Removed by Join Filter']?.toLocaleString()],
        ['Removed by recheck', r['Rows Removed by Index Recheck']?.toLocaleString()],
        ['Width', r['Plan Width'] != null ? `${r['Plan Width']} bytes` : undefined],
      ])}
      {section('Cost', [
        ['Startup … total', `${r['Startup Cost']} … ${r['Total Cost']}`],
        ['Self cost', <>{n.exclCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-subtle">({n.exclCostPct.toFixed(1)}%)</span></>],
      ])}
      {section('Buffers (inclusive)', [
        ['Shared hit', r['Shared Hit Blocks'] ? `${r['Shared Hit Blocks'].toLocaleString()} (${formatBlocks(r['Shared Hit Blocks'])})` : undefined],
        ['Shared read', r['Shared Read Blocks'] ? `${r['Shared Read Blocks'].toLocaleString()} (${formatBlocks(r['Shared Read Blocks'])})` : undefined],
        ['Shared dirtied', r['Shared Dirtied Blocks'] || undefined],
        ['Shared written', r['Shared Written Blocks'] || undefined],
        ['Local', (r['Local Hit Blocks'] || r['Local Read Blocks']) ? `hit ${r['Local Hit Blocks']} · read ${r['Local Read Blocks']}` : undefined],
        ['Temp', (r['Temp Read Blocks'] || r['Temp Written Blocks']) ? `read ${r['Temp Read Blocks']} · written ${r['Temp Written Blocks']}` : undefined],
        ['I/O read time', r['Shared I/O Read Time'] ?? r['I/O Read Time'] ? formatMs(r['Shared I/O Read Time'] ?? r['I/O Read Time']) : undefined],
        ['Self buffers', n.exclBlocks ? formatBlocks(n.exclBlocks) : undefined],
      ])}
      {section('Conditions', [
        ['Index', r['Index Name']],
        ['Index cond', mono(r['Index Cond'])],
        ['Hash cond', mono(r['Hash Cond'])],
        ['Merge cond', mono(r['Merge Cond'])],
        ['Join filter', mono(r['Join Filter'])],
        ['Recheck cond', mono(r['Recheck Cond'])],
        ['Filter', mono(r['Filter'])],
        ['One-time filter', mono(r['One-Time Filter'])],
        ['Sort key', mono(r['Sort Key'])],
        ['Group key', mono(r['Group Key'])],
      ])}
      {section('Details', other.map(([k, v]) => [k, typeof v === 'object' ? mono(JSON.stringify(v)) : typeof v === 'boolean' ? 'yes' : String(v)]))}
      {r['Output'] && section('Output', [['Columns', mono(r['Output'])]])}
    </div>
  );
}
