import { memo } from 'react';
import { EdgeLabelRenderer, getSmoothStepPath, Position, useInternalNode, type EdgeProps } from '@xyflow/react';
import { rowAnchorY, type RelationEdge as RelationEdgeType, type TableNode } from './model';
import { useErdUi } from './uiStore';

const STUB = 26;

/**
 * FK edge anchored to the exact column rows of both tables, with crow's-foot markers:
 *   child end:  circle + crow's foot (zero or many) or circle + bar (zero or one, FK columns unique)
 *   parent end: double bar (exactly one) or bar + circle (zero or one, when the FK is nullable)
 * Sides are picked from the current node positions, so edges stay tidy while dragging.
 */
function RelationEdgeImpl({ id, source, target, data }: EdgeProps<RelationEdgeType>) {
  const s = useInternalNode<TableNode>(source);
  const t = useInternalNode<TableNode>(target);
  const hi = useErdUi((st) => (st.active ? (st.active.edges.has(id) ? 1 : 0) : 2));
  const hovered = useErdUi((st) => st.hoveredEdge === id);
  if (!s || !t || !data) return null;
  const rel = data.rel;

  const sx = s.internals.positionAbsolute.x;
  const sw = s.measured.width ?? s.data.width;
  const sy = s.internals.positionAbsolute.y + rowAnchorY(s.data, rel.sourceColumns[0]);
  const tx = t.internals.positionAbsolute.x;
  const tw = t.measured.width ?? t.data.width;
  const ty = t.internals.positionAbsolute.y + rowAnchorY(t.data, rel.targetColumns[0]);

  let sSide: 1 | -1; // +1 = leaves from the right border
  let tSide: 1 | -1;
  if (source === target) { sSide = 1; tSide = 1; }
  else if (sx + sw + STUB * 1.5 <= tx) { sSide = 1; tSide = -1; }
  else if (tx + tw + STUB * 1.5 <= sx) { sSide = -1; tSide = 1; }
  else {
    // horizontally overlapping: route around the side closer to both
    const right = Math.abs(sx + sw - (tx + tw));
    const left = Math.abs(sx - tx);
    sSide = tSide = right <= left ? 1 : -1;
  }
  const x1 = sSide === 1 ? sx + sw : sx;
  const x2 = tSide === 1 ? tx + tw : tx;

  let path: string;
  let lx: number;
  let ly: number;
  if (source === target) {
    const ox = x1 + STUB + 14;
    const r = 6;
    const dy = ty > sy ? 1 : -1;
    path = `M ${x1} ${sy} H ${ox - r} Q ${ox} ${sy} ${ox} ${sy + dy * r} V ${ty - dy * r} Q ${ox} ${ty} ${ox - r} ${ty} H ${x2}`;
    lx = ox;
    ly = (sy + ty) / 2;
  } else {
    [path, lx, ly] = getSmoothStepPath({
      sourceX: x1, sourceY: sy, sourcePosition: sSide === 1 ? Position.Right : Position.Left,
      targetX: x2, targetY: ty, targetPosition: tSide === 1 ? Position.Right : Position.Left,
      borderRadius: 10, offset: STUB,
    });
  }

  const color = hovered || hi === 1 ? 'var(--accent)' : 'var(--subtle)';
  const opacity = hi === 0 ? 0.12 : hi === 1 || hovered ? 1 : 0.65;
  const width = hovered ? 2.4 : hi === 1 ? 1.8 : 1.25;

  // markers
  const m: string[] = [];
  const d1 = sSide;
  if (rel.oneToOne) {
    m.push(`M ${x1 + d1 * 10} ${sy - 6} V ${sy + 6}`);
  } else {
    m.push(`M ${x1 + d1 * 12} ${sy} L ${x1} ${sy - 6} M ${x1 + d1 * 12} ${sy} L ${x1} ${sy + 6}`);
  }
  const d2 = tSide;
  m.push(`M ${x2 + d2 * 8} ${ty - 6} V ${ty + 6}`);
  if (!rel.optional) m.push(`M ${x2 + d2 * 13} ${ty - 6} V ${ty + 6}`);

  const actions = [rel.onDelete !== 'NO ACTION' && `ON DELETE ${rel.onDelete}`, rel.onUpdate !== 'NO ACTION' && `ON UPDATE ${rel.onUpdate}`].filter(Boolean);

  return (
    <>
      <g style={{ opacity, transition: 'opacity 150ms' }}>
        <path d={path} style={{ fill: 'none', stroke: color, strokeWidth: width }} />
        <path d={m.join(' ')} style={{ fill: 'none', stroke: color, strokeWidth: Math.max(1.4, width), strokeLinecap: 'round' }} />
        <circle cx={x1 + d1 * (rel.oneToOne ? 17 : 19)} cy={sy} r={3.6} style={{ fill: 'var(--bg)', stroke: color, strokeWidth: 1.4 }} />
        {rel.optional && (
          <circle cx={x2 + d2 * 17} cy={ty} r={3.6} style={{ fill: 'var(--bg)', stroke: color, strokeWidth: 1.4 }} />
        )}
        {/* fat invisible hit area for hover */}
        <path d={path} style={{ fill: 'none', stroke: 'transparent', strokeWidth: 14 }} className="react-flow__edge-interaction" />
      </g>
      {hovered && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute z-[1000] rounded-md border border-border bg-elevated px-2 py-1 text-[11px] shadow-pop"
            style={{ transform: `translate(-50%, -120%) translate(${lx}px, ${ly}px)` }}
          >
            <div className="font-medium text-fg">{rel.name}</div>
            <div className="font-mono text-[10.5px] text-muted">
              {rel.source.split('.').pop()}({rel.sourceColumns.join(', ')}) → {rel.target.split('.').pop()}({rel.targetColumns.join(', ')})
            </div>
            <div className="text-[10.5px] text-subtle">
              {rel.oneToOne ? 'one-to-one' : 'many-to-one'}{rel.optional ? ' · optional' : ''}
              {actions.length ? ' · ' + actions.join(' · ') : ''}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RelationEdge = memo(RelationEdgeImpl);
