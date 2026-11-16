import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk-api';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { RelationEdge, TableNode } from './model';

/** ELK runs in a web worker so laying out hundreds of tables never blocks the UI. */
let elk: InstanceType<typeof ELK> | null = null;
function getElk() {
  if (!elk) elk = new ELK({ workerUrl });
  return elk;
}

const OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.nodeNode': '36',
  'elk.spacing.edgeNode': '24',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '72',
  'elk.layered.compaction.connectedComponents': 'true',
  'elk.aspectRatio': '1.8',
};

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Layered left→right layout. Referenced (parent) tables go left, referencing tables right.
 * (Column-level ports were tried: they make big graphs ~2x taller and slower for little gain,
 * edges are anchored to their exact columns at render time anyway.)
 */
export async function layoutGraph(nodes: TableNode[], edges: RelationEdge[]): Promise<Positions> {
  if (!nodes.length) return {};
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const elkEdges: ElkExtendedEdge[] = [];
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    const k = e.target + '\u0000' + e.source;
    if (seen.has(k)) continue; // parallel FKs between the same tables: one is enough for layout
    seen.add(k);
    elkEdges.push({ id: e.id, sources: [e.target], targets: [e.source] });
  }
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: OPTIONS,
    children: nodes.map((n) => ({ id: n.id, width: n.data.width, height: n.data.height })),
    edges: elkEdges,
  };
  const t0 = performance.now();
  const out = await getElk().layout(graph);
  console.debug(`[erd] ELK laid out ${nodes.length} tables / ${elkEdges.length} edges in ${Math.round(performance.now() - t0)} ms`);
  const pos: Positions = {};
  for (const c of out.children ?? []) pos[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  return pos;
}
