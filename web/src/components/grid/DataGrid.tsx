import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, KeyRound } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useSettings } from '@/stores/settings';
import { cellToText, isNumericType, renderCell } from './cell';
import type { CellPos, CellRange, CellValue, GridColumn, GridSort } from './types';

/**
 * High-performance virtualized data grid.
 *
 * Core contract (stable — other features depend on it):
 *   <DataGrid columns rows />                    read-only result grid
 *   sort / onSortChange                          header click sorting (controlled)
 *   rowOffset                                    row-number offset for paging
 *   renderCellOverride(row, col, value)          custom cell rendering (e.g. edited cells)
 *   rowClassName(row)                            row state styling (new / deleted / modified)
 *   onCellDoubleClick(pos), onSelectionChange(range)
 *   contextMenu(pos) => ReactNode wrapper is up to the parent via onCellContextMenu
 */
export interface DataGridProps {
  columns: GridColumn[];
  rows: CellValue[][];
  rowOffset?: number;
  sort?: GridSort | null;
  onSortChange?: (s: GridSort | null) => void;
  className?: string;
  emptyMessage?: ReactNode;
  renderCellOverride?: (row: number, col: number, value: CellValue) => ReactNode | undefined;
  rowClassName?: (row: number) => string | undefined;
  cellClassName?: (row: number, col: number) => string | undefined;
  onCellDoubleClick?: (pos: CellPos) => void;
  onCellContextMenu?: (pos: CellPos, e: React.MouseEvent) => void;
  onSelectionChange?: (range: CellRange | null) => void;
  /** Keyboard handler on the grid (return true if handled). */
  onKeyDown?: (e: React.KeyboardEvent, sel: CellRange | null) => boolean | void;
  selection?: CellRange | null;
}

const ROW_H = 26;
const HEADER_H = 30;
const ROWNUM_W = 52;

function defaultWidth(c: GridColumn, rows: CellValue[][], idx: number, charW: number): number {
  if (c.width) return c.width;
  let max = Math.max(c.name.length + 3, (c.typeName?.length ?? 0) + 2);
  const sample = Math.min(rows.length, 60);
  for (let i = 0; i < sample; i++) {
    const t = cellToText(rows[i][idx], 'NULL');
    if (t.length > max) max = t.length;
    if (max > 48) break;
  }
  return Math.min(Math.max(max * charW + 24, 70), 420);
}

export function normRange(r: CellRange) {
  return {
    r0: Math.min(r.start.row, r.end.row),
    r1: Math.max(r.start.row, r.end.row),
    c0: Math.min(r.start.col, r.end.col),
    c1: Math.max(r.start.col, r.end.col),
  };
}

export const DataGrid = memo(function DataGrid(props: DataGridProps) {
  const {
    columns, rows, rowOffset = 0, sort, onSortChange, className, emptyMessage,
    renderCellOverride, rowClassName, cellClassName, onCellDoubleClick, onCellContextMenu, onSelectionChange, onKeyDown,
  } = props;
  const fontSize = useSettings((s) => s.gridFontSize);
  const charW = fontSize * 0.6;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [innerSel, setInnerSel] = useState<CellRange | null>(null);
  const sel = props.selection !== undefined ? props.selection : innerSel;
  const dragging = useRef(false);

  const colKey = columns.map((c) => c.name + ':' + c.typeName).join('|');
  useEffect(() => {
    setWidths(columns.map((c, i) => defaultWidth(c, rows, i, charW)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey, charW]);

  const setSel = useCallback(
    (r: CellRange | null) => {
      setInnerSel(r);
      onSelectionChange?.(r);
    },
    [onSelectionChange],
  );

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const offsets = useMemo(() => {
    const o: number[] = [];
    let x = ROWNUM_W;
    for (const w of widths) { o.push(x); x += w; }
    return { starts: o, total: x };
  }, [widths]);

  const copySelection = useCallback(() => {
    if (!sel) return;
    const { r0, r1, c0, c1 } = normRange(sel);
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const cells: string[] = [];
      for (let c = c0; c <= c1; c++) cells.push(cellToText(rows[r]?.[c]));
      lines.push(cells.join('\t'));
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }, [sel, rows]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (onKeyDown?.(e, sel)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') { copySelection(); e.preventDefault(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      setSel({ start: { row: 0, col: 0 }, end: { row: rows.length - 1, col: columns.length - 1 } });
      e.preventDefault();
      return;
    }
    if (!sel) return;
    const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
    const mv = d[e.key];
    if (mv) {
      e.preventDefault();
      const base = e.shiftKey && e.key !== 'Tab' ? sel.end : sel.end;
      const next = {
        row: Math.max(0, Math.min(rows.length - 1, base.row + mv[0])),
        col: Math.max(0, Math.min(columns.length - 1, base.col + mv[1])),
      };
      setSel(e.shiftKey && e.key !== 'Tab' ? { start: sel.start, end: next } : { start: next, end: next });
      virt.scrollToIndex(next.row);
      const el = scrollRef.current;
      if (el) {
        const x = offsets.starts[next.col];
        const w = widths[next.col];
        if (x < el.scrollLeft + ROWNUM_W) el.scrollLeft = x - ROWNUM_W;
        else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
      }
    }
  };

  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: MouseEvent) => setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(48, w0 + ev.clientX - x0) : w)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const autoFit = (i: number) => {
    let max = columns[i].name.length + 3;
    for (let r = 0; r < Math.min(rows.length, 500); r++) max = Math.max(max, cellToText(rows[r][i], 'NULL').length);
    setWidths((ws) => ws.map((w, j) => (j === i ? Math.min(Math.max(max * charW + 24, 60), 800) : w)));
  };

  const clickHeader = (i: number) => {
    if (!onSortChange) return;
    if (!sort || sort.col !== i) onSortChange({ col: i, dir: 'asc' });
    else if (sort.dir === 'asc') onSortChange({ col: i, dir: 'desc' });
    else onSortChange(null);
  };

  const range = sel ? normRange(sel) : null;
  const items = virt.getVirtualItems();

  if (!columns.length) {
    return <div className={cn('flex h-full items-center justify-center text-xs text-subtle', className)}>{emptyMessage ?? 'No columns'}</div>;
  }

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className={cn('relative h-full w-full overflow-auto bg-bg outline-none', className)}
      style={{ fontSize }}
    >
      <div style={{ width: offsets.total, height: HEADER_H + virt.getTotalSize(), position: 'relative' }}>
        {/* header */}
        <div className="sticky top-0 z-20 flex border-b border-border bg-grid-header" style={{ height: HEADER_H, width: offsets.total }}>
          <div
            className="sticky left-0 z-30 flex shrink-0 cursor-pointer items-center justify-center border-r border-border bg-grid-header text-[10px] text-subtle"
            style={{ width: ROWNUM_W }}
            onClick={() => setSel({ start: { row: 0, col: 0 }, end: { row: rows.length - 1, col: columns.length - 1 } })}
            title="Select all"
          >
            #
          </div>
          {columns.map((c, i) => (
            <div
              key={i}
              className={cn(
                'group relative flex shrink-0 cursor-default items-center gap-1 border-r border-grid-line px-2 select-none',
                onSortChange && 'cursor-pointer hover:bg-hover',
                range && i >= range.c0 && i <= range.c1 && 'bg-accent-soft',
              )}
              style={{ width: widths[i] }}
              onClick={() => clickHeader(i)}
              title={c.description ?? `${c.name}${c.typeName ? ' · ' + c.typeName : ''}`}
            >
              {c.isPk && <KeyRound size={11} className="shrink-0 text-warning" />}
              <span className="truncate font-semibold text-fg">{c.name}</span>
              {c.typeName && <span className="truncate text-[10px] font-normal text-subtle">{c.typeName}</span>}
              {sort?.col === i && (sort.dir === 'asc' ? <ArrowUp size={12} className="ml-auto shrink-0 text-accent" /> : <ArrowDown size={12} className="ml-auto shrink-0 text-accent" />)}
              <div
                className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-accent/50"
                onMouseDown={(e) => startResize(i, e)}
                onDoubleClick={(e) => { e.stopPropagation(); autoFit(i); }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ))}
        </div>
        {/* rows */}
        {items.map((vr) => {
          const r = vr.index;
          const row = rows[r];
          const rowSelected = range && r >= range.r0 && r <= range.r1;
          return (
            <div
              key={vr.key}
              className={cn('absolute left-0 flex border-b border-grid-line', r % 2 === 1 && 'bg-grid-alt', rowClassName?.(r))}
              style={{ top: HEADER_H + vr.start, height: ROW_H, width: offsets.total }}
            >
              <div
                className={cn(
                  'sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border bg-grid-header pr-2 text-[10.5px] text-subtle tabular-nums select-none',
                  rowSelected && 'text-accent',
                )}
                style={{ width: ROWNUM_W }}
                onMouseDown={(e) => {
                  const end = { row: r, col: columns.length - 1 };
                  if (e.shiftKey && sel) setSel({ start: { row: sel.start.row, col: 0 }, end });
                  else setSel({ start: { row: r, col: 0 }, end });
                }}
              >
                {rowOffset + r + 1}
              </div>
              {columns.map((c, ci) => {
                const v = row[ci];
                const inSel = range && r >= range.r0 && r <= range.r1 && ci >= range.c0 && ci <= range.c1;
                const isCursor = sel && sel.end.row === r && sel.end.col === ci;
                const custom = renderCellOverride?.(r, ci, v);
                return (
                  <div
                    key={ci}
                    className={cn(
                      'flex shrink-0 items-center overflow-hidden border-r border-grid-line px-2 whitespace-nowrap text-fg',
                      isNumericType(c.typeName) && 'justify-end',
                      inSel && 'bg-selection',
                      isCursor && 'ring-2 ring-accent ring-inset',
                      cellClassName?.(r, ci),
                    )}
                    style={{ width: widths[ci] }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) {
                        if (!inSel) setSel({ start: { row: r, col: ci }, end: { row: r, col: ci } });
                        return;
                      }
                      dragging.current = true;
                      if (e.shiftKey && sel) setSel({ start: sel.start, end: { row: r, col: ci } });
                      else setSel({ start: { row: r, col: ci }, end: { row: r, col: ci } });
                      const up = () => { dragging.current = false; window.removeEventListener('mouseup', up); };
                      window.addEventListener('mouseup', up);
                    }}
                    onMouseEnter={() => {
                      if (dragging.current && sel) setSel({ start: sel.start, end: { row: r, col: ci } });
                    }}
                    onDoubleClick={() => onCellDoubleClick?.({ row: r, col: ci })}
                    onContextMenu={(e) => onCellContextMenu?.({ row: r, col: ci }, e)}
                  >
                    <span className="truncate">{custom !== undefined ? custom : renderCell(v, c.typeName)}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="absolute right-0 left-0 flex items-center justify-center py-10 text-xs text-subtle" style={{ top: HEADER_H }}>
            {emptyMessage ?? 'No rows'}
          </div>
        )}
      </div>
    </div>
  );
});
