import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, KeyRound } from 'lucide-react';
import {
  memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref,
} from 'react';
import { ContextMenu, toast, type MenuItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { modKey } from '@/lib/format';
import { useSettings } from '@/stores/settings';
import { cellToText, isNumericType, renderCell } from './cell';
import { CellEditor, type EditMove } from './CellEditor';
import { copyText, EXPORT_FORMATS, serializeRows, type ExportFormat } from './export';
import type { CellEditorSpec, CellPos, CellRange, CellValue, GridColumn, GridMenuContext, GridSelectionInfo, GridSort } from './types';
import { ValueViewer } from './ValueViewer';

/**
 * High-performance virtualized data grid (rows AND columns are virtualized).
 *
 * Core contract (stable — other features depend on it):
 *   <DataGrid columns rows />                    read-only result grid
 *   sort / onSortChange                          single-column sort (controlled)
 *   sorts / onSortsChange                        multi-column sort (shift-click adds a column)
 *   rowOffset                                    row-number offset for paging
 *   renderCellOverride(row, col, value)          custom cell rendering
 *   rowClassName(row) / cellClassName(row, col)  row & cell state styling (new / deleted / modified)
 *   onCellDoubleClick(pos), onCellContextMenu(pos, e), onSelectionChange(range, info)
 *   onKeyDown(e, sel)                            return true if handled
 *
 * Extensions:
 *   columnOrder / onColumnOrderChange            display order of data column indexes (missing = hidden)
 *   getCellEditor(row, col) + onCellEdit(pos, v) inline editing (text / choice) and long-value editor
 *   contextMenuItems(ctx)                        extra items at the top of the context menu
 *   tableName                                    used for "Copy as SQL INSERT"
 *   gridRef                                      imperative handle (focus, selection, editing)
 *
 * Positions passed to callbacks use DATA column indexes; CellRange uses DISPLAY indexes.
 * Built-ins: drag-select, shift-extend, row / column / all selection, keyboard navigation,
 * ⌘C copy, copy-as TSV/CSV/JSON/SQL/Markdown, column resize / auto-fit / reorder / hide,
 * value viewer (Space or double-click on read-only cells).
 */
export interface DataGridProps {
  columns: GridColumn[];
  rows: CellValue[][];
  rowOffset?: number;
  sort?: GridSort | null;
  onSortChange?: (s: GridSort | null) => void;
  sorts?: GridSort[];
  onSortsChange?: (s: GridSort[]) => void;
  className?: string;
  emptyMessage?: ReactNode;
  renderCellOverride?: (row: number, col: number, value: CellValue) => ReactNode | undefined;
  rowClassName?: (row: number) => string | undefined;
  cellClassName?: (row: number, col: number) => string | undefined;
  onCellDoubleClick?: (pos: CellPos) => void;
  onCellContextMenu?: (pos: CellPos, e: React.MouseEvent) => void;
  onSelectionChange?: (range: CellRange | null, info: GridSelectionInfo | null) => void;
  /** Keyboard handler on the grid (return true if handled). */
  onKeyDown?: (e: React.KeyboardEvent, sel: CellRange | null) => boolean | void;
  selection?: CellRange | null;

  columnOrder?: number[];
  onColumnOrderChange?: (order: number[]) => void;
  getCellEditor?: (row: number, col: number) => CellEditorSpec | null;
  onCellEdit?: (pos: CellPos, value: CellValue) => void;
  contextMenuItems?: (ctx: GridMenuContext) => MenuItem[];
  tableName?: string;
  /** Thin progress bar over the header. */
  loading?: boolean;
  gridRef?: Ref<DataGridHandle>;
  /** Label for the value viewer subtitle, e.g. row key. */
  describeRow?: (row: number) => string;
  /** When this changes, the grid scrolls back to the top (e.g. new query / page). */
  scrollKey?: string | number;
}

export interface DataGridHandle {
  focus: () => void;
  getSelection: () => GridSelectionInfo | null;
  /** Select a cell (data column index) and scroll it into view. */
  selectCell: (row: number, col: number) => void;
  startEdit: (row: number, col: number) => void;
  openValue: (row: number, col: number, edit?: boolean) => void;
  copySelection: (format?: ExportFormat, opts?: { fullRows?: boolean; header?: boolean }) => void;
  autoFitAll: () => void;
}

const ROW_H = 26;
const HEADER_H = 32;
const COL_OVERSCAN_PX = 400;

export function normRange(r: CellRange) {
  return {
    r0: Math.min(r.start.row, r.end.row),
    r1: Math.max(r.start.row, r.end.row),
    c0: Math.min(r.start.col, r.end.col),
    c1: Math.max(r.start.col, r.end.col),
  };
}

/** Header type label: explicit label, else the pg type name with arrays shown as int4[]. */
const typeLabelOf = (c: GridColumn) => c.typeLabel ?? (c.typeName?.startsWith('_') ? c.typeName.slice(1) + '[]' : c.typeName ?? '');

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function fitWidth(c: GridColumn, rows: CellValue[][], idx: number, fontSize: number, sample: number, max: number): number {
  const font = `${fontSize}px Inter, -apple-system, system-ui, sans-serif`;
  const headFont = `600 ${fontSize}px Inter, -apple-system, system-ui, sans-serif`;
  let w = textWidth(c.name, headFont) + (c.isPk ? 16 : 0) + textWidth(typeLabelOf(c), `${Math.max(9, fontSize - 2)}px Inter, system-ui`) + 52;
  const step = Math.max(1, Math.floor(rows.length / sample));
  for (let i = 0, n = 0; i < rows.length && n < sample; i += step, n++) {
    const t = cellToText(rows[i]?.[idx], 'NULL');
    const s = t.length > 120 ? t.slice(0, 120) : t;
    const tw = textWidth(s, font) + (typeof rows[i]?.[idx] === 'boolean' ? 14 : 0) + 20;
    if (tw > w) w = tw;
    if (w >= max) return max;
  }
  return Math.min(Math.max(Math.ceil(w), 64), max);
}

const sameRange = (a: CellRange | null, b: CellRange | null) =>
  a === b || (!!a && !!b && a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col);

export const DataGrid = memo(function DataGrid(props: DataGridProps) {
  const {
    columns, rows, rowOffset = 0, className, emptyMessage,
    renderCellOverride, rowClassName, cellClassName, onCellDoubleClick, onCellContextMenu, onSelectionChange, onKeyDown,
    getCellEditor, onCellEdit, contextMenuItems, tableName, loading,
  } = props;
  const fontSize = useSettings((s) => s.gridFontSize);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- columns: order, widths
  const colKey = columns.map((c) => c.name + ':' + c.typeName).join('|');
  const [innerOrder, setInnerOrder] = useState<number[]>(() => columns.map((_, i) => i));
  useEffect(() => setInnerOrder(columns.map((_, i) => i)), [colKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(
    () => (props.columnOrder ?? innerOrder).filter((i) => i >= 0 && i < columns.length),
    [props.columnOrder, innerOrder, columns.length],
  );
  const setOrder = (o: number[]) => {
    if (props.onColumnOrderChange) props.onColumnOrderChange(o);
    if (!props.columnOrder) setInnerOrder(o);
  };

  const [widths, setWidths] = useState<number[]>([]);
  const widthsFor = useRef('');
  useLayoutEffect(() => {
    // Size columns from the first rows that arrive; keep user sizes while paging.
    const key = colKey + '@' + fontSize;
    if (widthsFor.current === key && widths.length === columns.length) return;
    if (!rows.length && widthsFor.current === key) return;
    widthsFor.current = rows.length ? key : '';
    setWidths(columns.map((c, i) => c.width ?? fitWidth(c, rows, i, fontSize, 60, 360)));
  }, [colKey, fontSize, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const widthOf = (i: number) => widths[i] ?? 120;

  const rownumW = Math.max(44, String(rowOffset + rows.length).length * 7.5 + 22);
  const layout = useMemo(() => {
    const starts: number[] = [];
    let x = rownumW;
    for (const ci of order) { starts.push(x); x += widths[ci] ?? 120; }
    return { starts, total: x };
  }, [order, widths, rownumW]);

  // ---------------------------------------------------------------- selection
  const [innerSel, setInnerSel] = useState<CellRange | null>(null);
  const sel = props.selection !== undefined ? props.selection : innerSel;
  const selRef = useRef(sel);
  selRef.current = sel;

  const infoFor = useCallback((r: CellRange | null): GridSelectionInfo | null => {
    if (!r || !order.length) return null;
    const { r0, r1, c0, c1 } = normRange(r);
    return {
      r0, r1,
      cols: order.slice(c0, c1 + 1),
      cursor: { row: r.end.row, col: order[Math.min(r.end.col, order.length - 1)] },
      fullRows: c0 === 0 && c1 === order.length - 1,
    };
  }, [order]);

  const setSel = useCallback((r: CellRange | null) => {
    if (sameRange(selRef.current, r)) return;
    selRef.current = r;
    setInnerSel(r);
    onSelectionChange?.(r, infoFor(r));
  }, [onSelectionChange, infoFor]);

  // keep the selection inside the data when rows / columns shrink
  useEffect(() => {
    const s = selRef.current;
    if (!s) return;
    const maxR = rows.length - 1;
    const maxC = order.length - 1;
    if (maxR < 0 || maxC < 0) { setSel(null); return; }
    const clamp = (p: CellPos) => ({ row: Math.min(p.row, maxR), col: Math.min(p.col, maxC) });
    const n = { start: clamp(s.start), end: clamp(s.end) };
    if (!sameRange(n, s)) setSel(n);
  }, [rows.length, order.length, setSel]);

  // ---------------------------------------------------------------- virtualization
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });
  const [view, setView] = useState({ left: 0, width: 1600 });
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Only horizontal movement changes which columns render; vertical is handled by the virtualizer.
    if (el.scrollLeft === view.left && el.clientWidth === view.width) return;
    setView({ left: el.scrollLeft, width: el.clientWidth });
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [vc0, vc1] = useMemo(() => {
    const { starts } = layout;
    if (!starts.length) return [0, -1];
    const lo = view.left - COL_OVERSCAN_PX;
    const hi = view.left + view.width + COL_OVERSCAN_PX;
    let a = 0;
    let b = starts.length - 1;
    // binary search first column whose right edge is past `lo`
    let l = 0, h = starts.length - 1;
    while (l < h) {
      const m = (l + h) >> 1;
      if (starts[m] + widthOf(order[m]) < lo) l = m + 1; else h = m;
    }
    a = l;
    l = a; h = starts.length - 1;
    while (l < h) {
      const m = (l + h + 1) >> 1;
      if (starts[m] > hi) h = m - 1; else l = m;
    }
    b = l;
    return [a, b];
  }, [layout, view, order]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollKeyRef = useRef(props.scrollKey);
  useEffect(() => {
    if (scrollKeyRef.current === props.scrollKey) return;
    scrollKeyRef.current = props.scrollKey;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setSel(null);
  }, [props.scrollKey, setSel]);

  const scrollIntoView = useCallback((row: number, dcol: number) => {
    virt.scrollToIndex(row, { align: 'auto' });
    const el = scrollRef.current;
    if (!el || dcol < 0 || dcol >= layout.starts.length) return;
    const x = layout.starts[dcol];
    const w = widths[order[dcol]] ?? 120;
    if (x - rownumW < el.scrollLeft) el.scrollLeft = x - rownumW;
    else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(x - rownumW, x + w - el.clientWidth);
  }, [virt, layout, widths, order, rownumW]);

  const [menuCtx, setMenuCtx] = useState<GridMenuContext | null>(null);

  // ---------------------------------------------------------------- editing / viewer
  const [editing, setEditing] = useState<{ row: number; col: number; initial?: string } | null>(null);
  const [viewer, setViewer] = useState<{ row: number; col: number; edit: boolean } | null>(null);
  useEffect(() => { setEditing(null); }, [colKey]);

  const specFor = useCallback((row: number, col: number) => (onCellEdit && getCellEditor ? getCellEditor(row, col) : null), [onCellEdit, getCellEditor]);

  const startEdit = useCallback((row: number, col: number, initial?: string) => {
    const spec = specFor(row, col);
    if (!spec) return false;
    if (spec.kind === 'long') { setViewer({ row, col, edit: !spec.viewFirst }); return true; }
    const d = order.indexOf(col);
    scrollIntoView(row, d);
    setEditing({ row, col, initial });
    return true;
  }, [specFor, order, scrollIntoView]);

  const openValue = useCallback((row: number, col: number, edit = false) => {
    if (row < 0 || row >= rows.length) return;
    setViewer({ row, col, edit: edit && !!specFor(row, col) });
  }, [rows.length, specFor]);

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  const moveCursor = useCallback((dr: number, dc: number, extend = false) => {
    const s = selRef.current;
    if (!s) return;
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, s.end.row + dr)),
      col: Math.max(0, Math.min(order.length - 1, s.end.col + dc)),
    };
    setSel(extend ? { start: s.start, end: next } : { start: next, end: next });
    scrollIntoView(next.row, next.col);
  }, [rows.length, order.length, setSel, scrollIntoView]);

  const commitEdit = (v: CellValue, move: EditMove) => {
    const e = editing;
    setEditing(null);
    if (e) {
      const cur = rows[e.row]?.[e.col];
      if (v !== cur) onCellEdit?.({ row: e.row, col: e.col }, v);
    }
    focusGrid();
    if (move === 'down') moveCursor(1, 0);
    else if (move === 'up') moveCursor(-1, 0);
    else if (move === 'right') moveCursor(0, 1);
    else if (move === 'left') moveCursor(0, -1);
  };

  // ---------------------------------------------------------------- copy
  const copySelection = useCallback((format: ExportFormat = 'tsv', opts: { fullRows?: boolean; header?: boolean } = {}) => {
    const s = selRef.current;
    if (!s) return;
    const { r0, r1, c0, c1 } = normRange(s);
    const cols = opts.fullRows ? order : order.slice(c0, c1 + 1);
    const out: CellValue[][] = [];
    for (let r = r0; r <= r1; r++) out.push(cols.map((c) => rows[r]?.[c] ?? null));
    const gcols = cols.map((c) => columns[c]);
    const header = opts.header ?? (format !== 'tsv' || false);
    const text = serializeRows(gcols, out, format, { table: tableName, header });
    void copyText(text);
    const n = r1 - r0 + 1;
    const what = cols.length === 1 && n === 1 ? 'Cell' : `${n.toLocaleString()} row${n === 1 ? '' : 's'}${opts.fullRows ? '' : ` × ${cols.length} col${cols.length === 1 ? '' : 's'}`}`;
    toast.success(`${what} copied${format === 'tsv' && !opts.header ? '' : ` as ${EXPORT_FORMATS.find((f) => f.value === format)?.label}`}`);
  }, [order, rows, columns, tableName]);

  const autoFit = (dataCol: number) => {
    setWidths((ws) => ws.map((w, j) => (j === dataCol ? fitWidth(columns[j], rows, j, fontSize, 2000, 900) : w)));
  };
  const autoFitAll = () => setWidths(columns.map((c, i) => fitWidth(c, rows, i, fontSize, 500, 600)));

  useImperativeHandle(props.gridRef, () => ({
    focus: focusGrid,
    getSelection: () => infoFor(selRef.current),
    selectCell: (row, col) => {
      const d = order.indexOf(col);
      if (d < 0 || row < 0 || row >= rows.length) return;
      setSel({ start: { row, col: d }, end: { row, col: d } });
      scrollIntoView(row, d);
    },
    startEdit: (row, col) => { startEdit(row, col); },
    openValue,
    copySelection,
    autoFitAll,
  }));

  // ---------------------------------------------------------------- sorting
  const sortList: GridSort[] = props.sorts ?? (props.sort ? [props.sort] : []);
  const canSort = !!(props.onSortsChange || props.onSortChange);
  const applySort = (next: GridSort[]) => {
    if (props.onSortsChange) props.onSortsChange(next);
    else props.onSortChange?.(next[0] ?? null);
  };
  const clickSort = (col: number, additive: boolean) => {
    const cur = sortList.find((s) => s.col === col);
    const nextDir = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
    if (additive && props.onSortsChange) {
      const rest = sortList.filter((s) => s.col !== col);
      applySort(nextDir ? (cur ? sortList.map((s) => (s.col === col ? { col, dir: nextDir } : s)) : [...rest, { col, dir: nextDir }]) : rest);
    } else applySort(nextDir ? [{ col, dir: nextDir }] : []);
  };

  // ---------------------------------------------------------------- column drag (reorder) & header selection
  const [drag, setDrag] = useState<{ from: number; over: number; x: number } | null>(null);
  const headerMouseDown = (d: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    focusGrid();
    const x0 = e.clientX;
    let moved = false;
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const overAt = (clientX: number) => {
      const x = clientX - rect.left + el.scrollLeft;
      let o = layout.starts.findIndex((s, i) => x < s + (widths[order[i]] ?? 120) / 2);
      if (o < 0) o = order.length;
      return o;
    };
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      setDrag({ from: d, over: overAt(ev.clientX), x: ev.clientX - rect.left + el.scrollLeft });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) {
        const to = overAt(ev.clientX);
        setDrag(null);
        if (to !== d && to !== d + 1) {
          const next = [...order];
          const [c] = next.splice(d, 1);
          next.splice(to > d ? to - 1 : to, 0, c);
          setOrder(next);
        }
      } else if (rows.length) {
        const s = selRef.current;
        const last = rows.length - 1;
        if (e.shiftKey && s && s.start.row === 0 && s.end.row === last) setSel({ start: { row: 0, col: s.start.col }, end: { row: last, col: d } });
        else setSel({ start: { row: 0, col: d }, end: { row: last, col: d } });
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const startResize = (dataCol: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widthOf(dataCol);
    document.body.style.cursor = 'col-resize';
    const move = (ev: MouseEvent) => setWidths((ws) => ws.map((w, j) => (j === dataCol ? Math.max(40, w0 + ev.clientX - x0) : w)));
    const up = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ---------------------------------------------------------------- mouse selection on cells
  const dragging = useRef(false);
  const cellMouseDown = (r: number, d: number, e: React.MouseEvent) => {
    if (editing) return;
    const s = selRef.current;
    if (e.button !== 0) {
      const inSel = s && (() => { const n = normRange(s); return r >= n.r0 && r <= n.r1 && d >= n.c0 && d <= n.c1; })();
      if (!inSel) setSel({ start: { row: r, col: d }, end: { row: r, col: d } });
      return;
    }
    dragging.current = true;
    if (e.shiftKey && s) setSel({ start: s.start, end: { row: r, col: d } });
    else setSel({ start: { row: r, col: d }, end: { row: r, col: d } });
    const up = () => { dragging.current = false; window.removeEventListener('mouseup', up); };
    window.addEventListener('mouseup', up);
  };
  const cellMouseEnter = (r: number, d: number) => {
    const s = selRef.current;
    if (dragging.current && s) setSel({ start: s.start, end: { row: r, col: d } });
  };
  const rownumMouseDown = (r: number, e: React.MouseEvent) => {
    if (!order.length) return;
    const s = selRef.current;
    const lastC = order.length - 1;
    if (e.button !== 0) {
      if (!(s && r >= normRange(s).r0 && r <= normRange(s).r1)) setSel({ start: { row: r, col: 0 }, end: { row: r, col: lastC } });
      return;
    }
    e.preventDefault();
    focusGrid();
    const anchor = e.shiftKey && s ? s.start.row : r;
    setSel({ start: { row: anchor, col: 0 }, end: { row: r, col: lastC } });
    dragging.current = true;
    const up = () => { dragging.current = false; window.removeEventListener('mouseup', up); };
    window.addEventListener('mouseup', up);
  };
  const rownumMouseEnter = (r: number) => {
    const s = selRef.current;
    if (dragging.current && s && s.start.col === 0 && s.end.col === order.length - 1) setSel({ start: s.start, end: { row: r, col: order.length - 1 } });
  };
  const selectAll = () => {
    if (rows.length && order.length) setSel({ start: { row: 0, col: 0 }, end: { row: rows.length - 1, col: order.length - 1 } });
  };

  const cellDoubleClick = (r: number, c: number) => {
    onCellDoubleClick?.({ row: r, col: c });
    if (!startEdit(r, c)) openValue(r, c);
  };

  // Stable handler object so memoized rows only re-render when their own data changes.
  const handlerImpl = useRef<RowHandlers>(null as unknown as RowHandlers);
  handlerImpl.current = {
    cellMouseDown, cellMouseEnter, cellDoubleClick, rownumMouseDown, rownumMouseEnter,
    cellContextMenu: (r, c, e) => { setMenuCtx({ kind: 'cell', col: c, row: r, selection: null }); onCellContextMenu?.({ row: r, col: c }, e); },
    rownumContextMenu: (r) => setMenuCtx({ kind: 'rownum', col: order[0], row: r, selection: null }),
  };
  const handlers = useMemo<RowHandlers>(() => ({
    cellMouseDown: (...a) => handlerImpl.current.cellMouseDown(...a),
    cellMouseEnter: (...a) => handlerImpl.current.cellMouseEnter(...a),
    cellDoubleClick: (...a) => handlerImpl.current.cellDoubleClick(...a),
    cellContextMenu: (...a) => handlerImpl.current.cellContextMenu(...a),
    rownumMouseDown: (...a) => handlerImpl.current.rownumMouseDown(...a),
    rownumMouseEnter: (...a) => handlerImpl.current.rownumMouseEnter(...a),
    rownumContextMenu: (...a) => handlerImpl.current.rownumContextMenu(...a),
  }), []);

  // ---------------------------------------------------------------- keyboard
  const handleKey = (e: React.KeyboardEvent) => {
    if (editing || e.target !== scrollRef.current) return;
    const sel = selRef.current; // latest, even before React re-renders
    if (onKeyDown?.(e, sel)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection('tsv', { header: e.shiftKey });
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
    if (!sel) {
      if (rows.length && order.length && /^(Arrow|Tab|Home|End|Page)/.test(e.key)) {
        e.preventDefault();
        setSel({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } });
      }
      return;
    }
    const cur = sel.end;
    const curCol = order[cur.col];
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 2);
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveCursor(mod ? -cur.row : -1, 0, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); moveCursor(mod ? rows.length : 1, 0, e.shiftKey); return;
      case 'ArrowLeft': e.preventDefault(); moveCursor(0, mod ? -cur.col : -1, e.shiftKey); return;
      case 'ArrowRight': e.preventDefault(); moveCursor(0, mod ? order.length : 1, e.shiftKey); return;
      case 'Tab': e.preventDefault(); moveCursor(0, e.shiftKey ? -1 : 1); return;
      case 'PageDown': e.preventDefault(); moveCursor(page, 0, e.shiftKey); return;
      case 'PageUp': e.preventDefault(); moveCursor(-page, 0, e.shiftKey); return;
      case 'Home': e.preventDefault(); moveCursor(mod ? -cur.row : 0, -cur.col, e.shiftKey); return;
      case 'End': e.preventDefault(); moveCursor(mod ? rows.length : 0, order.length, e.shiftKey); return;
      case 'Escape':
        if (sel.start.row !== sel.end.row || sel.start.col !== sel.end.col) { e.preventDefault(); setSel({ start: cur, end: cur }); }
        return;
      case ' ':
        e.preventDefault();
        openValue(cur.row, curCol);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (!startEdit(cur.row, curCol)) openValue(cur.row, curCol);
        return;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      const spec = specFor(cur.row, curCol);
      if (spec && spec.kind !== 'long') {
        e.preventDefault();
        setSel({ start: cur, end: cur });
        startEdit(cur.row, curCol, e.key);
      }
    }
  };

  // ---------------------------------------------------------------- context menu
  const menuItems = (): MenuItem[] => {
    const ctx = menuCtx;
    if (!ctx) return [];
    const info = infoFor(selRef.current);
    const items: MenuItem[] = [];
    const extra = contextMenuItems?.({ ...ctx, selection: info }) ?? [];
    const fmtItems = (fullRows: boolean, header?: boolean): MenuItem[] =>
      EXPORT_FORMATS.map((f) => ({ label: f.label, onSelect: () => copySelection(f.value, { fullRows, header: f.value === 'tsv' ? header : undefined }) }));

    if (ctx.kind === 'header') {
      const c = columns[ctx.col];
      const cur = sortList.find((s) => s.col === ctx.col);
      if (canSort) {
        items.push(
          { label: 'Sort ascending', icon: <ArrowUp size={13} />, onSelect: () => applySort([{ col: ctx.col, dir: 'asc' }]) },
          { label: 'Sort descending', icon: <ArrowDown size={13} />, onSelect: () => applySort([{ col: ctx.col, dir: 'desc' }]) },
        );
        if (props.onSortsChange && sortList.length && !cur) {
          items.push({ label: 'Add to sort (then by)', onSelect: () => applySort([...sortList, { col: ctx.col, dir: 'asc' }]) });
        }
        if (cur) items.push({ label: 'Remove from sort', onSelect: () => applySort(sortList.filter((s) => s.col !== ctx.col)) });
        if (sortList.length) items.push({ label: 'Clear sort', onSelect: () => applySort([]) });
        items.push('separator');
      }
      items.push(
        { label: 'Copy column name', onSelect: () => { void copyText(c.name); toast.success('Column name copied'); } },
        {
          label: 'Copy column values', onSelect: () => {
            void copyText(rows.map((r) => cellToText(r[ctx.col])).join('\n'));
            toast.success(`${rows.length.toLocaleString()} values copied`);
          },
        },
        'separator',
        { label: 'Auto-fit column', onSelect: () => autoFit(ctx.col) },
        { label: 'Auto-fit all columns', onSelect: autoFitAll },
      );
      if (order.length > 1) items.push({ label: 'Hide column', onSelect: () => setOrder(order.filter((i) => i !== ctx.col)) });
      if (order.length < columns.length || order.some((v, i) => v !== i)) {
        items.push({ label: 'Show all columns (reset order)', onSelect: () => setOrder(columns.map((_, i) => i)) });
      }
      if (extra.length) items.push('separator', ...extra);
      return items;
    }

    if (extra.length) items.push(...extra, 'separator');
    const single = info && info.r0 === info.r1 && info.cols.length === 1;
    items.push(
      { label: 'View value…', shortcut: 'Space', onSelect: () => openValue(ctx.row, ctx.col) },
      'separator',
      { label: single ? 'Copy' : 'Copy selection', shortcut: `${modKey}C`, onSelect: () => copySelection('tsv') },
      { label: 'Copy with headers', shortcut: `⇧${modKey}C`, onSelect: () => copySelection('tsv', { header: true }) },
      { label: 'Copy selection as', items: fmtItems(false, true) },
      { label: info && info.r1 > info.r0 ? 'Copy rows as' : 'Copy row as', items: fmtItems(true, true) },
      { label: 'Copy column name', onSelect: () => { void copyText(columns[ctx.col]?.name ?? ''); toast.success('Column name copied'); } },
    );
    return items;
  };

  // ---------------------------------------------------------------- render
  const range = sel ? normRange(sel) : null;
  const items = virt.getVirtualItems();
  const totalH = HEADER_H + virt.getTotalSize();

  if (!columns.length) {
    return <div className={cn('flex h-full items-center justify-center text-xs text-subtle', className)}>{emptyMessage ?? 'No columns'}</div>;
  }

  const visibleD: number[] = [];
  for (let d = vc0; d <= vc1; d++) visibleD.push(d);
  const editSpec = editing ? specFor(editing.row, editing.col) : null;
  const editD = editing ? order.indexOf(editing.col) : -1;
  const viewerCol = viewer ? columns[viewer.col] : null;

  return (
    <>
      <ContextMenu items={menuItems} onOpenChange={(o) => { if (!o) setMenuCtx(null); }}>
        <div
          ref={scrollRef}
          tabIndex={0}
          role="grid"
          aria-rowcount={rows.length}
          aria-colcount={order.length}
          onKeyDown={handleKey}
          onScroll={onScroll}
          className={cn('relative h-full w-full overflow-auto bg-bg outline-none', className)}
          style={{ fontSize, overflowAnchor: 'none' }}
        >
          <div style={{ width: layout.total, height: Math.max(totalH, HEADER_H + 40), position: 'relative' }}>
            {/* header */}
            <div className="sticky top-0 z-20 border-b border-border bg-grid-header" style={{ height: HEADER_H, width: layout.total }}>
              <div
                className="sticky left-0 z-30 flex h-full cursor-pointer items-center justify-center border-r border-border bg-grid-header text-[10px] text-subtle hover:text-fg"
                style={{ width: rownumW }}
                onMouseDown={(e) => { e.preventDefault(); focusGrid(); selectAll(); }}
                title={`Select all (${modKey}A)`}
              >
                #
              </div>
              {visibleD.map((d) => {
                const ci = order[d];
                const c = columns[ci];
                const sIdx = sortList.findIndex((s) => s.col === ci);
                const s = sIdx >= 0 ? sortList[sIdx] : null;
                const colSelected = range && d >= range.c0 && d <= range.c1;
                const fullCol = colSelected && range.r0 === 0 && range.r1 === rows.length - 1;
                return (
                  <div
                    key={ci}
                    className={cn(
                      'group absolute top-0 flex h-full items-center gap-1 border-r border-grid-line pr-1 pl-2 select-none',
                      'cursor-default hover:bg-hover',
                      colSelected && 'bg-accent-soft',
                      fullCol && 'shadow-[inset_0_-2px_0_var(--accent)]',
                      drag?.from === d && 'opacity-40',
                    )}
                    style={{ left: layout.starts[d], width: widthOf(ci) }}
                    onMouseDown={(e) => headerMouseDown(d, e)}
                    onContextMenu={() => setMenuCtx({ kind: 'header', col: ci, row: -1, selection: null })}
                    title={c.description ?? `${c.name}${c.typeName ? ' · ' + c.typeName : ''}`}
                  >
                    {c.isPk && <KeyRound size={11} className="shrink-0 text-warning" />}
                    <span className="truncate font-semibold text-fg">{c.name}</span>
                    {(c.typeLabel ?? c.typeName) && <span className="min-w-0 shrink truncate text-[10px] font-normal text-subtle">{typeLabelOf(c)}</span>}
                    <span className="ml-auto" />
                    {canSort && (
                      <button
                        tabIndex={-1}
                        className={cn(
                          'flex h-5 shrink-0 items-center gap-px rounded px-0.5 hover:bg-active',
                          s ? 'text-accent' : 'text-subtle opacity-0 group-hover:opacity-100',
                        )}
                        title={`Sort${props.onSortsChange ? ' (⇧-click to add)' : ''}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); clickSort(ci, e.shiftKey); }}
                      >
                        {s ? (s.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} />}
                        {s && sortList.length > 1 && <span className="text-[9px] font-semibold tabular-nums">{sIdx + 1}</span>}
                      </button>
                    )}
                    <div
                      className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-accent/60"
                      onMouseDown={(e) => startResize(ci, e)}
                      onDoubleClick={(e) => { e.stopPropagation(); autoFit(ci); }}
                      title="Drag to resize · double-click to auto-fit"
                    />
                  </div>
                );
              })}
              {drag && (
                <div
                  className="pointer-events-none absolute top-0 z-40 w-0.5 bg-accent"
                  style={{ left: (drag.over < order.length ? layout.starts[drag.over] : layout.total) - 1, height: Math.min(totalH, 4000) }}
                />
              )}
              {loading && <div className="absolute h-0.5 animate-pulse bg-accent" style={{ top: HEADER_H - 2, left: view.left, width: view.width || '100%' }} />}
            </div>
            {/* rows */}
            {items.map((vr) => {
              const r = vr.index;
              const inRows = range && r >= range.r0 && r <= range.r1;
              return (
                <GridRow
                  key={vr.key}
                  r={r}
                  top={HEADER_H + vr.start}
                  row={rows[r]}
                  columns={columns}
                  order={order}
                  starts={layout.starts}
                  widths={widths}
                  total={layout.total}
                  rownumW={rownumW}
                  vc0={vc0}
                  vc1={vc1}
                  rowLabel={rowOffset + r + 1}
                  selC0={inRows ? range.c0 : -1}
                  selC1={inRows ? range.c1 : -1}
                  cursorD={sel && sel.end.row === r ? sel.end.col : -1}
                  fullRow={!!inRows && range.c0 === 0 && range.c1 === order.length - 1}
                  rowCls={rowClassName?.(r)}
                  cellClassName={cellClassName}
                  renderCellOverride={renderCellOverride}
                  h={handlers}
                />
              );
            })}
            {editing && editSpec && editD >= 0 && (
              <div className="absolute z-30" style={{ left: layout.starts[editD], top: HEADER_H + editing.row * ROW_H }}>
                <CellEditor
                  key={`${editing.row}:${editing.col}`}
                  spec={editSpec}
                  value={rows[editing.row]?.[editing.col] ?? null}
                  initial={editing.initial}
                  width={widthOf(editing.col)}
                  height={ROW_H}
                  fontSize={fontSize}
                  onCommit={commitEdit}
                  onCancel={() => { setEditing(null); focusGrid(); }}
                />
              </div>
            )}
            {rows.length === 0 && (
              <div className="sticky left-0 flex items-center justify-center py-10 text-xs text-subtle" style={{ top: HEADER_H, width: view.width || '100%' }}>
                {emptyMessage ?? 'No rows'}
              </div>
            )}
          </div>
        </div>
      </ContextMenu>
      {viewer && viewerCol && (
        <ValueViewer
          open
          onClose={() => { setViewer(null); focusGrid(); }}
          value={rows[viewer.row]?.[viewer.col] ?? null}
          columnName={viewerCol.name}
          typeName={viewerCol.typeName}
          typeLabel={viewerCol.typeLabel}
          rowLabel={props.describeRow?.(viewer.row) ?? `Row ${rowOffset + viewer.row + 1}`}
          startEditing={viewer.edit}
          nullable={specFor(viewer.row, viewer.col)?.nullable ?? true}
          onSave={specFor(viewer.row, viewer.col) ? (v) => onCellEdit?.({ row: viewer.row, col: viewer.col }, v) : undefined}
        />
      )}
    </>
  );
});

interface RowHandlers {
  cellMouseDown: (r: number, d: number, e: React.MouseEvent) => void;
  cellMouseEnter: (r: number, d: number) => void;
  cellDoubleClick: (r: number, c: number) => void;
  cellContextMenu: (r: number, c: number, e: React.MouseEvent) => void;
  rownumMouseDown: (r: number, e: React.MouseEvent) => void;
  rownumMouseEnter: (r: number) => void;
  rownumContextMenu: (r: number) => void;
}

interface GridRowProps {
  r: number;
  top: number;
  row: CellValue[];
  columns: GridColumn[];
  order: number[];
  starts: number[];
  widths: number[];
  total: number;
  rownumW: number;
  vc0: number;
  vc1: number;
  rowLabel: number;
  selC0: number;
  selC1: number;
  cursorD: number;
  fullRow: boolean;
  rowCls?: string;
  cellClassName?: (row: number, col: number) => string | undefined;
  renderCellOverride?: (row: number, col: number, value: CellValue) => ReactNode | undefined;
  h: RowHandlers;
}

const GridRow = memo(function GridRow(p: GridRowProps) {
  const { r, row, h } = p;
  if (!row) return null;
  const cells: ReactNode[] = [];
  for (let d = p.vc0; d <= p.vc1; d++) {
    const ci = p.order[d];
    const c = p.columns[ci];
    const v = row[ci];
    const inSel = d >= p.selC0 && d <= p.selC1;
    const isCursor = d === p.cursorD;
    const custom = p.renderCellOverride?.(r, ci, v);
    cells.push(
      <div
        key={ci}
        className={cn(
          'absolute top-0 flex h-full items-center overflow-hidden border-r border-grid-line px-2 whitespace-nowrap text-fg',
          isNumericType(c.typeName) && 'justify-end',
          p.cellClassName?.(r, ci),
          inSel && 'bg-selection',
          isCursor && 'shadow-[inset_0_0_0_2px_var(--accent)]',
        )}
        style={{ left: p.starts[d], width: p.widths[ci] ?? 120 }}
        onMouseDown={(e) => h.cellMouseDown(r, d, e)}
        onMouseEnter={() => h.cellMouseEnter(r, d)}
        onDoubleClick={() => h.cellDoubleClick(r, ci)}
        onContextMenu={(e) => h.cellContextMenu(r, ci, e)}
      >
        <span className="min-w-0 truncate">{custom !== undefined ? custom : renderCell(v, c.typeName)}</span>
      </div>,
    );
  }
  return (
    <div
      className={cn('absolute left-0 border-b border-grid-line', r % 2 === 1 ? 'bg-grid-alt' : 'bg-bg', p.rowCls)}
      style={{ top: p.top, height: ROW_H, width: p.total }}
    >
      <div
        className={cn(
          'sticky left-0 z-10 flex h-full items-center justify-end border-r border-border bg-grid-header pr-2 text-[10.5px] text-subtle tabular-nums select-none',
          p.selC0 >= 0 && 'text-accent',
          p.fullRow && 'bg-accent-soft font-medium',
        )}
        style={{ width: p.rownumW }}
        onMouseDown={(e) => h.rownumMouseDown(r, e)}
        onMouseEnter={() => h.rownumMouseEnter(r)}
        onContextMenu={() => h.rownumContextMenu(r)}
      >
        {p.rowLabel}
      </div>
      {cells}
    </div>
  );
});
