import type { Edge, Node } from '@xyflow/react';
import type { ErdColumn, ErdRelation, ErdResponse, ErdTable } from '@shared/erd';

/** Geometry shared by node rendering, edge anchoring and ELK layout (keep in sync with TableNode). */
export const HEADER_H = 36;
export const ROW_H = 22;
export const PAD_Y = 4;
export const MAX_ROWS = 40;

export interface TableNodeData extends Record<string, unknown> {
  table: ErdTable;
  /** Columns displayed (respects compact mode and MAX_ROWS). */
  rows: ErdColumn[];
  /** Columns not displayed because of MAX_ROWS. */
  hidden: number;
  color: string;
  width: number;
  height: number;
  compact: boolean;
}
export type TableNode = Node<TableNodeData, 'table'>;

export interface RelationEdgeData extends Record<string, unknown> {
  rel: ErdRelation;
}
export type RelationEdge = Edge<RelationEdgeData, 'relation'>;

/**
 * Schema accent palette. These are data colors (like a chart palette), chosen to read well on
 * both light and dark surfaces; everything else in the ERD uses semantic tokens.
 */
const PALETTE = ['#4f6ef7', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];

export function schemaColors(schemas: string[]): Map<string, string> {
  const m = new Map<string, string>();
  schemas.forEach((s, i) => m.set(s, PALETTE[i % PALETTE.length]));
  return m;
}

const SANS = 6.9; // ≈ px per char at 12px Inter
const MONO = 6.7; // ≈ px per char at 11px mono

function estimateWidth(t: ErdTable, rows: ErdColumn[]): number {
  const header = 20 + 18 + t.name.length * 7.6 + 16 + 54;
  let w = header;
  for (const c of rows) {
    const rw = 10 + 18 + c.name.length * SANS + 18 + Math.min(c.type.length, 26) * MONO + 10;
    if (rw > w) w = rw;
  }
  return Math.round(Math.min(380, Math.max(210, w)));
}

export function nodeHeight(rowCount: number): number {
  return HEADER_H + (rowCount ? PAD_Y * 2 + rowCount * ROW_H : 0);
}

/** Y offset (relative to node top) of a column's anchor, or the header center when not displayed. */
export function rowAnchorY(data: TableNodeData, column: string | undefined): number {
  if (column) {
    const i = data.rows.findIndex((c) => c.name === column);
    if (i >= 0) return HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2;
  }
  return HEADER_H / 2;
}

export function buildGraph(data: ErdResponse, compact: boolean, colors: Map<string, string>) {
  const nodes: TableNode[] = data.tables.map((t) => {
    let cols = compact ? t.columns.filter((c) => c.pk || c.fk) : t.columns;
    const hidden = Math.max(0, cols.length - MAX_ROWS);
    if (hidden) {
      // keep keys visible even when truncating very wide tables
      const keys = cols.filter((c) => c.pk || c.fk);
      const rest = cols.filter((c) => !c.pk && !c.fk).slice(0, Math.max(0, MAX_ROWS - keys.length));
      const keep = new Set([...keys, ...rest]);
      cols = cols.filter((c) => keep.has(c));
    }
    const rowCount = cols.length + (hidden ? 1 : 0);
    const width = estimateWidth(t, cols);
    const height = nodeHeight(rowCount);
    return {
      id: t.id,
      type: 'table',
      position: { x: 0, y: 0 },
      width,
      height,
      data: { table: t, rows: cols, hidden, color: colors.get(t.schema) ?? PALETTE[0], width, height, compact },
    };
  });
  const edges: RelationEdge[] = data.relations.map((r) => ({
    id: r.id,
    type: 'relation',
    source: r.source,
    target: r.target,
    data: { rel: r },
    selectable: false,
    focusable: false,
  }));
  return { nodes, edges };
}

/** table id -> neighbor table ids and incident edge ids */
export function adjacency(relations: ErdRelation[]) {
  const nb = new Map<string, Set<string>>();
  const inc = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(v);
  };
  for (const r of relations) {
    add(nb, r.source, r.target);
    add(nb, r.target, r.source);
    add(inc, r.source, r.id);
    add(inc, r.target, r.id);
  }
  return { nb, inc };
}
