/**
 * EXPLAIN (FORMAT JSON) model: parsing, derived metrics (exclusive time/cost/buffers,
 * misestimates) and a PostgreSQL-like text rendering.
 */

export type RawNode = Record<string, any> & { 'Node Type': string; Plans?: RawNode[] };

export interface PlanNode {
  id: number;
  depth: number;
  raw: RawNode;
  type: string;
  children: PlanNode[];
  parent?: PlanNode;
  /** e.g. "on shop.orders o" / "using orders_pkey" */
  title: string;
  /** Hash Cond / Filter etc. one-liner */
  hint?: string;
  loops: number;
  neverExecuted: boolean;
  /** inclusive actual time (ms, all loops) */
  inclTime: number;
  exclTime: number;
  exclTimePct: number;
  exclCost: number;
  exclCostPct: number;
  actualRows?: number;
  /** total rows over all loops */
  actualRowsTotal?: number;
  planRows: number;
  /** >= 1; how far off the estimate is */
  estFactor: number;
  estDir: 'under' | 'over' | 'ok';
  /** exclusive shared blocks (hit + read) */
  exclBlocks: number;
  exclBlocksPct: number;
  rowsRemoved?: number;
}

export interface ExplainResult {
  analyzed: boolean;
  raw: any;
  root: PlanNode;
  nodes: PlanNode[];
  planningTime?: number;
  executionTime?: number;
  totalCost: number;
  totalTime: number;
  totalBlocks: number;
  triggers: { name: string; relation?: string; time: number; calls: number }[];
  jit?: Record<string, any>;
  settings?: Record<string, string>;
  /** set for EXPLAIN ANALYZE of data-modifying statements that were rolled back */
  rolledBack?: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

export function nodeTitle(n: RawNode): string {
  const parts: string[] = [];
  if (n['Index Name'] && !n['Relation Name']) parts.push(`using ${n['Index Name']}`);
  if (n['Relation Name']) {
    const rel = (n['Schema'] && n['Schema'] !== 'public' ? n['Schema'] + '.' : '') + n['Relation Name'];
    parts.push(`on ${rel}${n['Alias'] && n['Alias'] !== n['Relation Name'] ? ' ' + n['Alias'] : ''}`);
    if (n['Index Name']) parts.push(`using ${n['Index Name']}`);
  }
  if (n['CTE Name']) parts.push(`on ${n['CTE Name']}${n['Alias'] && n['Alias'] !== n['CTE Name'] ? ' ' + n['Alias'] : ''}`);
  if (n['Function Name']) parts.push(`on ${n['Function Name']}()${n['Alias'] ? ' ' + n['Alias'] : ''}`);
  if (n['Subplan Name']) parts.push(n['Subplan Name']);
  return parts.join(' ');
}

export function nodeLabel(n: RawNode): string {
  let t = n['Node Type'];
  if (t === 'Aggregate' && n['Strategy']) t = { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Plain: 'Aggregate', Mixed: 'MixedAggregate' }[n['Strategy'] as string] ?? t;
  if (n['Join Type'] && n['Join Type'] !== 'Inner' && /Join|Nested Loop/.test(t)) t = `${t} (${n['Join Type']})`;
  if (n['Parallel Aware']) t = `Parallel ${t}`;
  if (t === 'ModifyTable' && n['Operation']) t = n['Operation'];
  if (n['Scan Direction'] === 'Backward') t += ' Backward';
  return t;
}

const CONDS = ['Hash Cond', 'Merge Cond', 'Join Filter', 'Index Cond', 'Recheck Cond', 'Filter', 'One-Time Filter', 'TID Cond'];

/** Parse EXPLAIN JSON output (string or parsed array). */
export function parseExplain(input: unknown): ExplainResult {
  let data: any = input;
  if (typeof data === 'string') data = JSON.parse(data);
  if (Array.isArray(data)) data = data[0];
  if (!data?.Plan) throw new Error('Not an EXPLAIN (FORMAT JSON) result');
  const rootRaw: RawNode = data.Plan;
  const analyzed = 'Actual Total Time' in rootRaw || 'Actual Loops' in rootRaw || data['Execution Time'] != null;
  const nodes: PlanNode[] = [];

  const build = (raw: RawNode, depth: number, parent?: PlanNode): PlanNode => {
    const loops = num(raw['Actual Loops']) || (analyzed ? 0 : 1);
    const node: PlanNode = {
      id: nodes.length,
      depth,
      raw,
      parent,
      type: nodeLabel(raw),
      children: [],
      title: nodeTitle(raw),
      hint: CONDS.map((c) => raw[c] && `${c}: ${raw[c]}`).find(Boolean) as string | undefined,
      loops,
      neverExecuted: analyzed && num(raw['Actual Loops']) === 0,
      inclTime: num(raw['Actual Total Time']) * (loops || 0),
      exclTime: 0,
      exclTimePct: 0,
      exclCost: 0,
      exclCostPct: 0,
      actualRows: analyzed ? num(raw['Actual Rows']) : undefined,
      actualRowsTotal: analyzed ? num(raw['Actual Rows']) * (loops || 0) : undefined,
      planRows: num(raw['Plan Rows']),
      estFactor: 1,
      estDir: 'ok',
      exclBlocks: 0,
      exclBlocksPct: 0,
      rowsRemoved: raw['Rows Removed by Filter'] ?? raw['Rows Removed by Join Filter'] ?? raw['Rows Removed by Index Recheck'],
    };
    nodes.push(node);
    node.children = (raw.Plans ?? []).map((c) => build(c, depth + 1, node));
    return node;
  };
  const root = build(rootRaw, 0);

  const blocks = (r: RawNode) => num(r['Shared Hit Blocks']) + num(r['Shared Read Blocks']) + num(r['Local Hit Blocks']) + num(r['Local Read Blocks']) + num(r['Temp Read Blocks']);
  const totalCost = num(rootRaw['Total Cost']);
  const totalTime = analyzed ? Math.max(num(data['Execution Time']), root.inclTime) : 0;
  const totalBlocks = blocks(rootRaw);

  for (const n of nodes) {
    // InitPlans/SubPlans attached to a node are counted in its time, so subtract all children
    const childTime = n.children.reduce((a, c) => a + c.inclTime, 0);
    // For parallel nodes under Gather, worker time is spread; clamp to >= 0
    n.exclTime = Math.max(0, n.inclTime - childTime);
    const childCost = n.children.filter((c) => c.raw['Parent Relationship'] !== 'InitPlan').reduce((a, c) => a + num(c.raw['Total Cost']), 0);
    n.exclCost = Math.max(0, num(n.raw['Total Cost']) - childCost);
    n.exclBlocks = Math.max(0, blocks(n.raw) - n.children.reduce((a, c) => a + blocks(c.raw), 0));
    n.exclTimePct = totalTime > 0 ? (n.exclTime / totalTime) * 100 : 0;
    n.exclCostPct = totalCost > 0 ? (n.exclCost / totalCost) * 100 : 0;
    n.exclBlocksPct = totalBlocks > 0 ? (n.exclBlocks / totalBlocks) * 100 : 0;
    if (analyzed && !n.neverExecuted) {
      const a = Math.max(n.actualRows ?? 0, 1);
      const p = Math.max(n.planRows, 1);
      n.estFactor = a >= p ? a / p : p / a;
      n.estDir = n.estFactor < 2 ? 'ok' : a > p ? 'under' : 'over';
    }
  }

  const triggers = ((data.Triggers ?? []) as any[]).map((t) => ({ name: t['Trigger Name'], relation: t['Relation'], time: num(t['Time']), calls: num(t['Calls']) }));
  return {
    analyzed,
    raw: input,
    root,
    nodes,
    planningTime: data['Planning Time'],
    executionTime: data['Execution Time'],
    totalCost,
    totalTime,
    totalBlocks,
    triggers,
    jit: data.JIT,
    settings: data.Settings,
  };
}

/** Render a plan the way psql's FORMAT TEXT does (close enough to read & share). */
export function planToText(r: ExplainResult): string {
  const lines: string[] = [];
  const f2 = (v: number) => v.toFixed(2);
  const fT = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  const walk = (n: PlanNode, depth: number) => {
    const raw = n.raw;
    const pad = depth === 0 ? '' : ' '.repeat(depth * 6 - 4) + '->  ';
    const detailPad = ' '.repeat(depth === 0 ? 2 : depth * 6 + 2);
    let head = `${pad}${n.type}${n.title ? ' ' + n.title : ''}  (cost=${f2(num(raw['Startup Cost']))}..${f2(num(raw['Total Cost']))} rows=${raw['Plan Rows']} width=${raw['Plan Width']})`;
    if (r.analyzed) head += n.neverExecuted ? ' (never executed)' : ` (actual time=${fT(num(raw['Actual Startup Time']))}..${fT(num(raw['Actual Total Time']))} rows=${raw['Actual Rows']} loops=${raw['Actual Loops']})`;
    if (raw['Subplan Name'] && depth > 0) lines.push(' '.repeat(depth * 6 - 4) + raw['Subplan Name']);
    lines.push(head);
    if (raw['Output']) lines.push(`${detailPad}Output: ${(raw['Output'] as string[]).join(', ')}`);
    for (const c of CONDS) if (raw[c]) lines.push(`${detailPad}${c}: ${raw[c]}`);
    if (raw['Rows Removed by Filter'] != null) lines.push(`${detailPad}Rows Removed by Filter: ${raw['Rows Removed by Filter']}`);
    if (raw['Rows Removed by Join Filter'] != null) lines.push(`${detailPad}Rows Removed by Join Filter: ${raw['Rows Removed by Join Filter']}`);
    if (raw['Sort Key']) lines.push(`${detailPad}Sort Key: ${(raw['Sort Key'] as string[]).join(', ')}`);
    if (raw['Sort Method']) lines.push(`${detailPad}Sort Method: ${raw['Sort Method']}  ${raw['Sort Space Type'] ?? ''}: ${raw['Sort Space Used'] ?? ''}kB`);
    if (raw['Group Key']) lines.push(`${detailPad}Group Key: ${(raw['Group Key'] as string[]).join(', ')}`);
    if (raw['Hash Buckets'] != null) lines.push(`${detailPad}Buckets: ${raw['Hash Buckets']}  Batches: ${raw['Hash Batches']}  Memory Usage: ${raw['Peak Memory Usage']}kB`);
    if (raw['Heap Fetches'] != null) lines.push(`${detailPad}Heap Fetches: ${raw['Heap Fetches']}`);
    if (raw['Workers Planned'] != null) lines.push(`${detailPad}Workers Planned: ${raw['Workers Planned']}${raw['Workers Launched'] != null ? `\n${detailPad}Workers Launched: ${raw['Workers Launched']}` : ''}`);
    const buf = bufferText(raw);
    if (buf) lines.push(`${detailPad}Buffers: ${buf}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(r.root, 0);
  if (r.planningTime != null) lines.push(`Planning Time: ${fT(r.planningTime)} ms`);
  for (const t of r.triggers) lines.push(`Trigger ${t.name}${t.relation ? ` on ${t.relation}` : ''}: time=${fT(t.time)} calls=${t.calls}`);
  if (r.executionTime != null) lines.push(`Execution Time: ${fT(r.executionTime)} ms`);
  return lines.join('\n');
}

export function bufferText(raw: RawNode): string {
  const parts: string[] = [];
  const seg = (label: string, keys: [string, string][]) => {
    const vals = keys.filter(([, k]) => num(raw[k]) > 0).map(([n, k]) => `${n}=${raw[k]}`);
    if (vals.length) parts.push(`${label} ${vals.join(' ')}`);
  };
  seg('shared', [['hit', 'Shared Hit Blocks'], ['read', 'Shared Read Blocks'], ['dirtied', 'Shared Dirtied Blocks'], ['written', 'Shared Written Blocks']]);
  seg('local', [['hit', 'Local Hit Blocks'], ['read', 'Local Read Blocks'], ['dirtied', 'Local Dirtied Blocks'], ['written', 'Local Written Blocks']]);
  seg('temp', [['read', 'Temp Read Blocks'], ['written', 'Temp Written Blocks']]);
  return parts.join(', ');
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 100) return `${ms.toFixed(2)} ms`;
  if (ms < 10_000) return `${Math.round(ms).toLocaleString()} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatRows(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** 8 kB blocks → human size */
export function formatBlocks(blocks: number): string {
  const bytes = blocks * 8192;
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
