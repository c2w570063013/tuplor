import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Copy, CopyPlus, Download, FileCode2, Filter, Lock, Plus,
  RefreshCw, RotateCcw, Trash2, Undo2, Upload, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilterCondition, RowsQuery, SortSpec, TableColumn, TableInfo } from '@shared/tableData';
import type { CellValue, QueryError } from '@shared/types';
import {
  DataGrid, DEFAULT_VALUE, EXPORT_FORMATS, cellToText, copyText, downloadUrl, exportRows, isDefaultMarker, serializeRows,
  type CellEditorSpec, type DataGridHandle, type GridColumn, type GridMenuContext, type GridSort,
} from '@/components/grid';
import {
  Badge, Button, DropdownMenu, EmptyState, IconButton, Kbd, Select, Spinner, Toolbar, ToolbarDivider, Tooltip, toast, type MenuItem,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount, formatDuration, modKey, qualified } from '@/lib/format';
import { invalidateDb } from '@/lib/queryClient';
import { confirm, confirmSql } from '@/stores/dialogs';
import { useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import type { TabProps } from '../common/TabProps';
import { shortType, tableApi, TEMPORAL_HINT } from './api';
import { ColumnsIcon, ColumnsMenu } from './ColumnsMenu';
import { cleanConditions, FilterBar, type FilterDraft, type FilterMode } from './FilterBar';
import {
  buildChanges, countChanges, EMPTY, insertedDisplayRow, mergedRow, setCell, setInsertCell, type Staged,
} from './staged';

interface Params {
  schema: string;
  table: string;
  objectKind?: string;
  filters?: FilterCondition[];
  where?: string;
  filterMode?: FilterMode;
  sort?: SortSpec[];
  /** Visible columns in display order (names). */
  columns?: string[];
  pageSize?: number;
  hideNotice?: boolean;
}

const KIND_LABEL: Record<TableInfo['kind'], string> = {
  table: 'Table', partitioned_table: 'Partitioned table', view: 'View', materialized_view: 'Materialized view', foreign_table: 'Foreign table',
};
const PAGE_SIZES = [50, 100, 200, 500, 1000, 5000];

function editorSpec(col: TableColumn, value: CellValue): CellEditorSpec {
  const nullable = col.nullable;
  if (col.udtName === 'bool') {
    return { kind: 'choice', nullable, options: [{ label: 'true', value: true }, { label: 'false', value: false }] };
  }
  if (col.enumValues && !col.isArray) return { kind: 'choice', nullable, options: col.enumValues.map((v) => ({ label: v, value: v })) };
  if (col.udtName === 'json' || col.udtName === 'jsonb') return { kind: 'long', language: 'json', nullable };
  if (col.udtName === 'bytea' || col.udtName === 'xml') return { kind: 'long', nullable };
  if (typeof value === 'string' && (value.includes('\n') || value.length > 160)) return { kind: 'long', nullable };
  return {
    kind: 'text', nullable,
    placeholder: col.isArray ? '{a,b,c}' : TEMPORAL_HINT[col.udtName],
  };
}

export default function TableDataTab({ tab, active }: TabProps) {
  const params = tab.params as Params;
  const { schema, table } = params;
  const connId = tab.connId!;
  const db = tab.database!;
  const qc = useQueryClient();
  const settingsPageSize = useSettings((s) => s.pageSize);
  const confirmDangerous = useSettings((s) => s.confirmDangerous);
  const pageSize = params.pageSize ?? settingsPageSize;
  const setParams = useCallback((p: Partial<Params>) => useWorkspace.getState().updateParams(tab.id, p), [tab.id]);
  const gridRef = useRef<DataGridHandle>(null);
  const [selRows, setSelRows] = useState(0);

  // ---------------------------------------------------------------- metadata
  const infoQ = useQuery({
    queryKey: ['table-info', connId, db, schema, table],
    queryFn: () => tableApi.info(connId, db, schema, table),
    staleTime: 60_000,
  });
  const info = infoQ.data;
  const cols = useMemo(() => info?.columns ?? [], [info]);
  const colIndex = useMemo(() => new Map(cols.map((c, i) => [c.name, i])), [cols]);

  // ---------------------------------------------------------------- applied query (persisted in tab params)
  const filterMode: FilterMode = params.filterMode ?? 'builder';
  const query: RowsQuery = useMemo(() => {
    const sort = (params.sort ?? []).filter((s) => !info || colIndex.has(s.column));
    if (filterMode === 'sql') return { where: params.where?.trim() || undefined, sort };
    return { filters: cleanConditions((params.filters ?? []).filter((f) => !info || colIndex.has(f.column))), sort };
  }, [params.filters, params.where, params.sort, filterMode, info, colIndex]);
  const queryKey = JSON.stringify(query);
  const activeFilterCount = filterMode === 'sql' ? (query.where ? 1 : 0) : query.filters?.length ?? 0;

  const [draft, setDraft] = useState<FilterDraft>(() => ({ mode: filterMode, conditions: params.filters ?? [], where: params.where ?? '' }));
  const [showFilters, setShowFilters] = useState(activeFilterCount > 0);
  const [page, setPage] = useState(0);
  const offset = page * pageSize;

  // ---------------------------------------------------------------- data
  const rowsQ = useQuery({
    queryKey: ['table-rows', connId, db, schema, table, queryKey, page, pageSize],
    queryFn: ({ signal }) => tableApi.rows(connId, db, schema, table, { ...query, offset, limit: pageSize }, signal),
    enabled: !!info,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  const estQ = useQuery({
    queryKey: ['table-count', connId, db, schema, table, queryKey],
    queryFn: () => tableApi.count(connId, db, schema, table, query, false),
    enabled: !!info,
    staleTime: Infinity,
  });
  const [exact, setExact] = useState<{ key: string; count: number; ms: number } | null>(null);
  const [counting, setCounting] = useState(false);
  const baseRows = useMemo(() => rowsQ.data?.rows ?? [], [rowsQ.data]);
  const hasMore = rowsQ.data?.hasMore ?? false;
  const rowsError = rowsQ.error as ApiError | null;

  // exact total: counted, or derivable on the last page
  const exactTotal = exact?.key === queryKey ? exact.count : rowsQ.data && !hasMore && !rowsQ.isPlaceholderData ? offset + baseRows.length : null;
  const estimate = estQ.data?.count ?? null;
  const lastPage = exactTotal != null ? Math.max(0, Math.ceil(exactTotal / pageSize) - 1) : null;

  // ---------------------------------------------------------------- staged edits
  const [staged, setStaged] = useState<Staged>(EMPTY);
  const history = useRef<Staged[]>([]);
  const pending = countChanges(staged);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<QueryError | null>(null);

  const change = useCallback((fn: (s: Staged) => Staged) => {
    setStaged((s) => {
      const n = fn(s);
      if (n !== s) {
        history.current.push(s);
        if (history.current.length > 200) history.current.shift();
      }
      return n;
    });
    setCommitError(null);
  }, []);
  const resetStaged = useCallback(() => { setStaged(EMPTY); history.current = []; setCommitError(null); }, []);
  const undo = () => {
    const prev = history.current.pop();
    if (prev) setStaged(prev);
  };

  useEffect(() => {
    const dirty = pending.total > 0;
    if (!!tab.dirty !== dirty) useWorkspace.getState().updateTab(tab.id, { dirty });
  }, [pending.total, tab.dirty, tab.id]);

  /** Run an action that reloads data; asks before discarding staged edits. */
  const guard = useCallback(async (fn: () => void) => {
    if (countChanges(staged).total > 0) {
      const ok = await confirm({
        title: 'Discard pending changes?',
        message: `You have ${countChanges(staged).total} uncommitted change(s). Reloading the data will discard them.`,
        danger: true,
        confirmLabel: 'Discard changes',
      });
      if (!ok) return;
      resetStaged();
    }
    fn();
  }, [staged, resetStaged]);

  const displayRows = useMemo(() => {
    if (!info) return [];
    const out = baseRows.map((r, i) => mergedRow(r, staged.updates[i]));
    for (const ins of staged.inserts) out.push(insertedDisplayRow(info, ins));
    return out;
  }, [baseRows, staged, info]);
  const nBase = baseRows.length;
  const isNew = (r: number) => r >= nBase;

  // ---------------------------------------------------------------- grid columns / order / sort
  const gridColumns = useMemo<GridColumn[]>(() => cols.map((c) => ({
    name: c.name,
    typeName: c.udtName,
    typeLabel: shortType(c),
    isPk: c.isPrimaryKey,
    description: [
      `${c.name} · ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`,
      c.identity ? `identity (${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'})` : c.isGenerated ? `generated: ${c.default ?? ''}` : c.default ? `default ${c.default}` : '',
      c.comment ?? '',
    ].filter(Boolean).join('\n'),
  })), [cols]);

  const order = useMemo(() => {
    if (!params.columns?.length) return cols.map((_, i) => i);
    const o = params.columns.map((n) => colIndex.get(n)).filter((i): i is number => i !== undefined);
    return o.length ? o : cols.map((_, i) => i);
  }, [params.columns, cols, colIndex]);
  const setOrder = (o: number[]) => setParams({ columns: o.length === cols.length && o.every((v, i) => v === i) ? undefined : o.map((i) => cols[i].name) });

  const gridSorts = useMemo<GridSort[]>(
    () => (query.sort ?? []).map((s) => ({ col: colIndex.get(s.column)!, dir: s.dir })).filter((s) => s.col !== undefined),
    [query.sort, colIndex],
  );
  const onSortsChange = (s: GridSort[]) => guard(() => { setParams({ sort: s.map((x) => ({ column: cols[x.col].name, dir: x.dir })) }); setPage(0); });

  // ---------------------------------------------------------------- editability
  const canEditAny = !!info && (info.canInsert || info.canUpdate || info.canDelete);
  const cellEditable = useCallback((r: number, c: number) => {
    if (!info) return false;
    const col = cols[c];
    if (!col?.updatable) return false;
    if (r >= nBase) return info.canInsert;
    return info.canUpdate && !staged.deleted[r];
  }, [info, cols, nBase, staged.deleted]);

  const getCellEditor = useCallback((r: number, c: number) => (cellEditable(r, c) ? editorSpec(cols[c], displayRows[r]?.[c] ?? null) : null),
    [cellEditable, cols, displayRows]);

  const editCell = useCallback((r: number, c: number, v: CellValue) => {
    if (!cellEditable(r, c)) return;
    if (r >= nBase) change((s) => setInsertCell(s, r - nBase, c, v));
    else change((s) => setCell(s, r, c, v, baseRows[r][c]));
  }, [cellEditable, nBase, baseRows, change]);

  const selection = () => gridRef.current?.getSelection() ?? null;
  const forSelectedCells = (fn: (r: number, c: number) => void) => {
    const sel = selection();
    if (!sel) return;
    for (let r = sel.r0; r <= sel.r1; r++) for (const c of sel.cols) fn(r, c);
  };
  const setSelectedTo = (v: CellValue, test: (col: TableColumn) => boolean) => {
    let n = 0;
    forSelectedCells((r, c) => {
      if (cellEditable(r, c) && test(cols[c])) { editCell(r, c, v); n++; }
    });
    if (!n) toast.info('No editable cells in the selection');
  };
  const revertSelected = () => {
    const sel = selection();
    if (!sel) return;
    change((s) => {
      const updates = { ...s.updates };
      for (let r = sel.r0; r <= sel.r1; r++) {
        if (!updates[r]) continue;
        const m = { ...updates[r] };
        for (const c of sel.cols) delete m[c];
        if (Object.keys(m).length && !sel.fullRows) updates[r] = m;
        else delete updates[r];
      }
      const deleted = { ...s.deleted };
      if (sel.fullRows) for (let r = sel.r0; r <= sel.r1; r++) delete deleted[r];
      return { ...s, updates, deleted };
    });
  };

  const pendingFocus = useRef<number | null>(null);
  const addRow = (values: Record<number, CellValue> = {}) => {
    if (!info?.canInsert) return;
    change((s) => ({ ...s, inserts: [...s.inserts, { key: Math.random().toString(36).slice(2), values }] }));
    pendingFocus.current = nBase + staged.inserts.length;
  };
  useEffect(() => {
    const r = pendingFocus.current;
    if (r == null || r >= displayRows.length) return;
    pendingFocus.current = null;
    const first = order.find((c) => cols[c].updatable && !cols[c].identity && !(cols[c].isPrimaryKey && cols[c].default)) ?? order[0];
    requestAnimationFrame(() => {
      gridRef.current?.selectCell(r, first);
      gridRef.current?.focus();
    });
  }, [displayRows.length, order, cols]);

  const duplicateSelected = () => {
    const sel = selection();
    if (!sel || !info?.canInsert) return;
    const newRows: Record<number, CellValue>[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const src = displayRows[r];
      const values: Record<number, CellValue> = {};
      cols.forEach((col, i) => {
        if (!col.updatable || col.identity || (col.isPrimaryKey && col.default != null)) return;
        if (isDefaultMarker(src[i])) return;
        values[i] = src[i];
      });
      newRows.push(values);
    }
    change((s) => ({ ...s, inserts: [...s.inserts, ...newRows.map((values) => ({ key: Math.random().toString(36).slice(2), values }))] }));
    pendingFocus.current = nBase + staged.inserts.length;
    toast.success(`${newRows.length} row${newRows.length > 1 ? 's' : ''} duplicated — edit and commit`);
  };

  const deleteSelected = () => {
    const sel = selection();
    if (!sel || !info) return;
    const existing: number[] = [];
    const created: number[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) (r >= nBase ? created : existing).push(r);
    if (existing.length && !info.canDelete) {
      toast.error("Rows can't be deleted", { description: info.readOnlyReason ?? undefined });
      if (!created.length) return;
    }
    change((s) => {
      const deleted = { ...s.deleted };
      if (info.canDelete) {
        const allDeleted = existing.every((r) => deleted[r]);
        for (const r of existing) { if (allDeleted) delete deleted[r]; else deleted[r] = true; }
      }
      const inserts = s.inserts.filter((_, i) => !created.includes(i + nBase));
      return { ...s, deleted, inserts };
    });
  };

  // ---------------------------------------------------------------- commit
  const commit = async (review = false) => {
    if (!info || committing) return;
    const changes = buildChanges(info, baseRows, staged);
    if (!changes.length) return;
    const c = countChanges(staged);
    try {
      if (review || (confirmDangerous && c.deleted > 0)) {
        const prev = await tableApi.commit(connId, db, schema, table, { changes, preview: true });
        const ok = await confirmSql({
          title: review ? 'Review pending changes' : `Delete ${c.deleted} row${c.deleted > 1 ? 's' : ''}?`,
          message: review
            ? 'These statements run in a single transaction. If any statement fails, nothing is saved.'
            : `This permanently deletes ${c.deleted} row${c.deleted > 1 ? 's' : ''} from ${schema}.${table}${c.total > c.deleted ? ' together with the other pending changes' : ''}.`,
          sql: prev.sql,
          danger: c.deleted > 0,
          confirmLabel: 'Commit',
        });
        if (!ok) return;
      }
      setCommitting(true);
      setCommitError(null);
      const r = await tableApi.commit(connId, db, schema, table, { changes });
      const parts = [r.updated && `${r.updated} updated`, r.inserted && `${r.inserted} inserted`, r.deleted && `${r.deleted} deleted`].filter(Boolean);
      toast.success(`Committed · ${parts.join(', ')}`, { description: `${schema}.${table} · ${formatDuration(r.durationMs)}` });
      resetStaged();
      setExact(null);
      await Promise.all([rowsQ.refetch(), estQ.refetch()]);
      invalidateDb(connId, db);
    } catch (e) {
      const err = e instanceof ApiError ? e.info : { message: String(e) };
      setCommitError(err);
      toast.error('Commit failed — nothing was saved', { description: err.message });
    } finally {
      setCommitting(false);
    }
  };

  const discard = async () => {
    if (!pending.total) return;
    if (await confirm({ title: 'Discard all pending changes?', message: `${pending.total} change(s) will be lost.`, danger: true, confirmLabel: 'Discard' })) resetStaged();
  };

  // ---------------------------------------------------------------- navigation / refresh
  const refresh = () => guard(() => {
    setExact(null);
    void rowsQ.refetch();
    void estQ.refetch();
    void qc.invalidateQueries({ queryKey: ['table-info', connId, db, schema, table] });
  });
  const goPage = (p: number) => guard(() => setPage(Math.max(0, p)));
  const countExact = async () => {
    setCounting(true);
    try {
      const r = await tableApi.count(connId, db, schema, table, query, true);
      setExact({ key: queryKey, count: r.count, ms: r.durationMs });
      return r.count;
    } catch (e) {
      toast.error('Count failed', { description: (e as Error).message });
      return null;
    } finally {
      setCounting(false);
    }
  };
  const goLast = async () => {
    let total = exactTotal;
    if (total == null) total = await countExact();
    if (total != null) goPage(Math.max(0, Math.ceil(total / pageSize) - 1));
  };

  // reset page when the query changes underneath (e.g. external param update)
  const lastQueryKey = useRef(queryKey);
  useEffect(() => {
    if (lastQueryKey.current !== queryKey) { lastQueryKey.current = queryKey; setPage(0); }
  }, [queryKey]);

  // ---------------------------------------------------------------- filters
  const appliedDraftKey = JSON.stringify({ m: filterMode, c: params.filters ?? [], w: params.where ?? '' });
  const draftKey = JSON.stringify({ m: draft.mode, c: draft.conditions, w: draft.where });
  const applyFilters = (d: FilterDraft = draft) => guard(() => {
    setDraft(d);
    setParams({ filters: d.conditions, where: d.where, filterMode: d.mode });
    setPage(0);
  });
  const clearFilters = () => applyFilters({ mode: draft.mode, conditions: [], where: '' });
  const quickFilter = (cond: FilterCondition) => {
    const d: FilterDraft = { mode: 'builder', conditions: [...(filterMode === 'builder' ? params.filters ?? [] : []), cond], where: draft.where };
    setShowFilters(true);
    applyFilters(d);
  };
  const toggleFilters = () => {
    setShowFilters((s) => {
      if (!s && !draft.conditions.length && draft.mode === 'builder' && cols.length) {
        setDraft({ ...draft, conditions: [{ column: cols[0].name, op: '=', value: '' }] });
      }
      return !s;
    });
  };

  // ---------------------------------------------------------------- export
  const visibleCols = order.map((i) => cols[i].name);
  const target = qualified(schema, table);
  const exportPage = (format: (typeof EXPORT_FORMATS)[number]['value']) => {
    exportRows(order.map((i) => gridColumns[i]), displayRows.map((r) => order.map((i) => r[i])), format, `${schema}.${table}_page${page + 1}`, target);
  };
  const exportAll = (format: (typeof EXPORT_FORMATS)[number]['value']) => {
    downloadUrl(tableApi.exportUrl(connId, db, schema, table, format, query, order.length < cols.length || order.some((v, i) => v !== i) ? visibleCols : undefined));
    toast.success('Export started', { description: `All ${exactTotal != null ? exactTotal.toLocaleString() : estimate != null ? '~' + formatCount(estimate) : ''} matching rows are streamed from the server.` });
  };
  const copyPage = (format: (typeof EXPORT_FORMATS)[number]['value']) => {
    void copyText(serializeRows(order.map((i) => gridColumns[i]), displayRows.map((r) => order.map((i) => r[i])), format, { table: target, header: true }));
    toast.success(`${displayRows.length} rows copied as ${EXPORT_FORMATS.find((f) => f.value === format)?.label}`);
  };
  const exportItems: MenuItem[] = [
    { heading: `Current page (${displayRows.length.toLocaleString()} rows)` },
    ...EXPORT_FORMATS.map((f) => ({ label: `Export as ${f.label}`, onSelect: () => exportPage(f.value) })),
    { label: 'Copy page as', icon: <Copy size={13} />, items: EXPORT_FORMATS.map((f) => ({ label: f.label, onSelect: () => copyPage(f.value) })) },
    'separator',
    { heading: `All rows${activeFilterCount ? ' matching filter' : ''} (streamed)` },
    ...EXPORT_FORMATS.map((f) => ({ label: `Export all as ${f.label}`, icon: f.value === 'csv' ? <Download size={13} /> : undefined, onSelect: () => exportAll(f.value) })),
  ];

  const openImport = () => useWorkspace.getState().openTab({
    kind: 'import', title: `Import · ${table}`, connId, database: db, key: `import:${connId}:${db}:${schema}.${table}`, params: { schema, table },
  });
  const openInSql = () => {
    const sql = rowsQ.data?.sqlLiteral;
    if (sql) useWorkspace.getState().newQuery({ connId, database: db, sql: sql + ';\n', title: `${table}.sql` });
  };

  // ---------------------------------------------------------------- context menu
  const contextMenuItems = (ctx: GridMenuContext): MenuItem[] => {
    if (!info) return [];
    const items: MenuItem[] = [];
    const col = cols[ctx.col];
    if (ctx.kind === 'header') {
      return [{ label: `Filter by ${col.name}…`, icon: <Filter size={13} />, onSelect: () => {
        setShowFilters(true);
        setDraft({ ...draft, mode: 'builder', conditions: [...draft.conditions.filter((c) => c.column && (c.value || c.values?.length || c.op.startsWith('IS'))), { column: col.name, op: '=', value: '' }] });
      } }];
    }
    const sel = ctx.selection;
    const editable = ctx.kind === 'cell' && cellEditable(ctx.row, ctx.col);
    const anyEditable = (() => {
      if (!sel) return false;
      for (let r = sel.r0; r <= sel.r1; r++) for (const c of sel.cols) if (cellEditable(r, c)) return true;
      return false;
    })();
    if (ctx.kind === 'cell') {
      if (editable) {
        items.push({ label: 'Edit cell', shortcut: '↵', onSelect: () => gridRef.current?.startEdit(ctx.row, ctx.col) });
        items.push({ label: 'Open in value editor…', onSelect: () => gridRef.current?.openValue(ctx.row, ctx.col, true) });
      }
      if (anyEditable) {
        items.push({ label: 'Set NULL', onSelect: () => setSelectedTo(null, (c) => c.nullable) });
        if (sel?.cols.some((c) => cols[c].default != null || cols[c].identity)) {
          items.push({ label: 'Set DEFAULT', onSelect: () => setSelectedTo(DEFAULT_VALUE, (c) => c.default != null || !!c.identity) });
        }
      }
    }
    const touched = sel && Array.from({ length: sel.r1 - sel.r0 + 1 }, (_, i) => sel.r0 + i).some((r) => staged.updates[r] || staged.deleted[r]);
    if (touched) items.push({ label: sel?.fullRows ? 'Revert row changes' : 'Revert cell changes', icon: <RotateCcw size={13} />, onSelect: revertSelected });
    if (items.length) items.push('separator');

    if (ctx.kind === 'cell' && !isNew(ctx.row)) {
      const v = baseRows[ctx.row]?.[ctx.col];
      const name = col.name;
      const short = (s: string) => (s.length > 28 ? s.slice(0, 28) + '…' : s);
      const sub: MenuItem[] = v === null
        ? [{ label: `${name} IS NULL`, onSelect: () => quickFilter({ column: name, op: 'IS NULL' }) }]
        : [
          { label: `${name} = ${short(cellToText(v))}`, onSelect: () => quickFilter({ column: name, op: '=', value: cellToText(v) }) },
          { label: `${name} ≠ ${short(cellToText(v))}`, onSelect: () => quickFilter({ column: name, op: '<>', value: cellToText(v) }) },
          ...(typeof v === 'string' && !col.isArray && col.udtName !== 'json' && col.udtName !== 'jsonb'
            ? [{ label: `${name} contains “${short(v)}”`, onSelect: () => quickFilter({ column: name, op: 'ILIKE', value: `%${v}%` }) }] : []),
          { label: `${name} IS NOT NULL`, onSelect: () => quickFilter({ column: name, op: 'IS NOT NULL' }) },
        ];
      items.push({ label: 'Filter rows where', icon: <Filter size={13} />, items: sub }, 'separator');
    }
    if (info.canInsert) {
      items.push({ label: 'Add row', icon: <Plus size={13} />, onSelect: () => addRow() });
      items.push({ label: sel && sel.r1 > sel.r0 ? `Duplicate ${sel.r1 - sel.r0 + 1} rows` : 'Duplicate row', icon: <CopyPlus size={13} />, shortcut: `${modKey}D`, onSelect: duplicateSelected });
    }
    if (info.canDelete || (sel && sel.r1 >= nBase)) {
      const n = sel ? sel.r1 - sel.r0 + 1 : 1;
      const allDeleted = sel && Array.from({ length: n }, (_, i) => sel.r0 + i).every((r) => r >= nBase || staged.deleted[r]);
      items.push({
        label: allDeleted && sel && sel.r0 < nBase ? `Restore ${n > 1 ? `${n} rows` : 'row'}` : `Delete ${n > 1 ? `${n} rows` : 'row'}`,
        icon: <Trash2 size={13} />, danger: !allDeleted, shortcut: '⌫', onSelect: deleteSelected,
      });
    }
    return items;
  };

  // ---------------------------------------------------------------- styling of staged state
  const rowClassName = useCallback((r: number) => {
    if (r >= nBase) return 'bg-success-soft!';
    if (staged.deleted[r]) return 'bg-danger-soft!';
    return undefined;
  }, [nBase, staged.deleted]);
  const cellClassName = useCallback((r: number, c: number) => {
    if (r < nBase && staged.deleted[r]) return 'line-through decoration-danger/70 text-muted';
    if (r < nBase && staged.updates[r] && c in staged.updates[r]) return 'bg-warning-soft shadow-[inset_2px_0_0_var(--warning)]';
    if (r >= nBase && c in (staged.inserts[r - nBase]?.values ?? {})) return 'shadow-[inset_2px_0_0_var(--success)]';
    return undefined;
  }, [nBase, staged]);

  const describeRow = (r: number) => {
    if (!info) return '';
    if (r >= nBase) return 'New row (not yet committed)';
    const key = info.keyColumns.map((k) => `${k} = ${cellToText(baseRows[r]?.[colIndex.get(k)!], 'NULL')}`).join(', ');
    return `Row ${offset + r + 1}${key ? ' · ' + key : ''}`;
  };

  // ---------------------------------------------------------------- keyboard
  const onGridKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && canEditAny) { e.preventDefault(); deleteSelected(); return true; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return true; }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return true; }
    if (mod && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); addRow(); return true; }
    return false;
  };
  const onRootKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void commit(e.shiftKey); }
    else if ((mod && e.key.toLowerCase() === 'r') || e.key === 'F5') { e.preventDefault(); refresh(); }
    else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); if (!showFilters) toggleFilters(); }
  };
  // ⌘S must also work when focus is outside the tab (e.g. after clicking a toolbar button that was then removed)
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!active || !pending.total) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.defaultPrevented) {
        e.preventDefault();
        void commitRef.current(e.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, pending.total]);

  // ---------------------------------------------------------------- render
  if (infoQ.isLoading) return <div className="flex h-full items-center justify-center"><Spinner size={18} className="text-subtle" /></div>;
  if (infoQ.error || !info) {
    return (
      <EmptyState
        icon={<AlertCircle size={28} />}
        title={`Can't open ${schema}.${table}`}
        description={(infoQ.error as Error)?.message ?? 'Unknown error'}
        action={<Button onClick={() => infoQ.refetch()}>Retry</Button>}
      />
    );
  }

  const shownFrom = baseRows.length ? offset + 1 : 0;
  const shownTo = offset + baseRows.length;
  const totalLabel = exactTotal != null ? exactTotal.toLocaleString() : estimate != null ? `~${formatCount(estimate)}` : '…';

  return (
    <div className="flex h-full flex-col" onKeyDown={onRootKey}>
      <Toolbar className="gap-0.5">
        <IconButton label="Refresh" shortcut={`${modKey}R`} onClick={refresh}><RefreshCw size={14} className={cn(rowsQ.isFetching && 'animate-spin')} /></IconButton>
        <ToolbarDivider />
        <Button
          size="sm"
          variant={showFilters || activeFilterCount ? 'secondary' : 'ghost'}
          icon={<Filter size={13} />}
          onClick={toggleFilters}
          className={cn(activeFilterCount > 0 && 'text-accent')}
          title={`Filter (${modKey}F)`}
        >
          Filter{activeFilterCount > 0 && <Badge tone="accent" className="ml-0.5">{activeFilterCount}</Badge>}
        </Button>
        <ColumnsMenu
          columns={cols}
          order={order}
          onChange={setOrder}
          trigger={
            <Button size="sm" variant={order.length < cols.length ? 'secondary' : 'ghost'} icon={<ColumnsIcon size={13} />}>
              Columns{order.length < cols.length && <Badge className="ml-0.5">{order.length}/{cols.length}</Badge>}
            </Button>
          }
        />
        {gridSorts.length > 0 && (
          <Tooltip content="Clear sort">
            <button
              className="ml-1 flex h-6 items-center gap-1 rounded-md bg-accent-soft px-2 text-[11px] text-accent hover:bg-active"
              onClick={() => onSortsChange([])}
            >
              {query.sort!.map((s) => `${s.column} ${s.dir === 'asc' ? '↑' : '↓'}`).join(', ')}
              <X size={11} />
            </button>
          </Tooltip>
        )}
        <ToolbarDivider />
        {info.canInsert && (
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => addRow()} title={`Add row (⇧${modKey}↵)`}>Row</Button>
        )}
        {info.canInsert && (
          <IconButton label="Duplicate selected rows" shortcut={`${modKey}D`} onClick={duplicateSelected}><CopyPlus size={14} /></IconButton>
        )}
        {info.canDelete && (
          <IconButton label="Delete selected rows" shortcut="⌫" onClick={deleteSelected}><Trash2 size={14} /></IconButton>
        )}
        {!canEditAny && (
          <Tooltip content={info.readOnlyReason ?? 'Read-only'}>
            <span className="ml-1 flex items-center gap-1 rounded-md bg-active px-2 py-0.5 text-[11px] text-muted"><Lock size={11} /> Read-only</span>
          </Tooltip>
        )}
        <div className="flex-1" />
        <DropdownMenu
          align="end"
          trigger={<Button size="sm" variant="ghost" icon={<Download size={13} />}>Export</Button>}
          items={exportItems}
        />
        {info.canInsert && (
          <Button size="sm" variant="ghost" icon={<Upload size={13} />} onClick={openImport}>Import CSV…</Button>
        )}
        <IconButton label="Open query in SQL editor" onClick={openInSql} disabled={!rowsQ.data}><FileCode2 size={14} /></IconButton>
      </Toolbar>

      {showFilters && (
        <FilterBar
          columns={cols}
          draft={draft}
          onChange={setDraft}
          onApply={() => applyFilters()}
          onClear={clearFilters}
          dirty={draftKey !== appliedDraftKey}
        />
      )}

      {info.readOnlyReason && !params.hideNotice && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-warning-soft px-3 py-1.5 text-[12px] text-fg">
          <Lock size={13} className="mt-0.5 shrink-0 text-warning" />
          <span className="flex-1">{info.readOnlyReason}</span>
          <button className="shrink-0 text-subtle hover:text-fg" aria-label="Dismiss" onClick={() => setParams({ hideNotice: true })}><X size={13} /></button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {rowsError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
            <div className="max-w-xl rounded-lg border border-danger/40 bg-danger-soft p-4 text-[13px]">
              <div className="flex items-center gap-2 font-medium text-danger"><AlertCircle size={15} /> {rowsError.message}</div>
              {rowsError.info?.detail && <div className="mt-1 text-xs text-muted">{rowsError.info.detail}</div>}
              {rowsError.info?.hint && <div className="mt-1 text-xs text-muted">Hint: {rowsError.info.hint}</div>}
            </div>
            <div className="flex gap-2">
              {activeFilterCount > 0 && <Button onClick={clearFilters}>Clear filters</Button>}
              {gridSorts.length > 0 && <Button onClick={() => onSortsChange([])}>Clear sort</Button>}
              <Button variant="ghost" onClick={() => rowsQ.refetch()}>Retry</Button>
            </div>
          </div>
        ) : !rowsQ.data && rowsQ.isLoading ? (
          <div className="flex h-full items-center justify-center"><Spinner size={18} className="text-subtle" /></div>
        ) : (
          <DataGrid
            gridRef={gridRef}
            className="h-full"
            columns={gridColumns}
            rows={displayRows}
            rowOffset={offset}
            sorts={gridSorts}
            onSortsChange={onSortsChange}
            columnOrder={order}
            onColumnOrderChange={setOrder}
            getCellEditor={canEditAny ? getCellEditor : undefined}
            onCellEdit={canEditAny ? (p, v) => editCell(p.row, p.col, v) : undefined}
            contextMenuItems={contextMenuItems}
            rowClassName={rowClassName}
            cellClassName={cellClassName}
            onKeyDown={onGridKey}
            onSelectionChange={(_, i) => setSelRows(i ? i.r1 - i.r0 + 1 : 0)}
            tableName={target}
            loading={rowsQ.isFetching}
            describeRow={describeRow}
            emptyMessage={
              <span className="flex flex-col items-center gap-2">
                <span>{activeFilterCount ? 'No rows match the filter' : 'This table is empty'}</span>
                {activeFilterCount > 0 ? <Button size="xs" onClick={clearFilters}>Clear filters</Button>
                  : info.canInsert ? <Button size="xs" icon={<Plus size={12} />} onClick={() => addRow()}>Add row</Button> : null}
              </span>
            }
          />
        )}
      </div>

      {pending.total > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-accent/30 bg-accent-soft px-3 py-1.5 text-[12px]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />
          <span className="font-medium text-fg">{pending.total} pending change{pending.total > 1 ? 's' : ''}</span>
          <span className="truncate text-muted">
            {[
              pending.cellsUpdated && `${pending.cellsUpdated} cell${pending.cellsUpdated > 1 ? 's' : ''} in ${pending.rowsUpdated} row${pending.rowsUpdated > 1 ? 's' : ''}`,
              pending.inserted && `${pending.inserted} new`,
              pending.deleted && `${pending.deleted} deleted`,
            ].filter(Boolean).join(' · ')}
          </span>
          {commitError && (
            <Tooltip content={[commitError.detail, commitError.hint && `Hint: ${commitError.hint}`, commitError.where].filter(Boolean).join('\n') || commitError.message}>
              <span className="flex min-w-0 items-center gap-1 truncate text-danger"><AlertCircle size={13} className="shrink-0" /> {commitError.message}</span>
            </Tooltip>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <IconButton size="sm" label="Undo last change" shortcut={`${modKey}Z`} onClick={undo} disabled={!history.current.length}><Undo2 size={13} /></IconButton>
            <Button size="xs" variant="ghost" onClick={discard}>Discard</Button>
            <Button size="xs" variant="outline" onClick={() => commit(true)}>Review SQL</Button>
            <Button size="xs" variant="primary" loading={committing} onClick={() => commit(false)}>
              Commit <Kbd className="border-white/30 bg-white/15 text-white">{modKey}S</Kbd>
            </Button>
          </div>
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-panel px-2 text-[11px] text-subtle">
        <Badge>{KIND_LABEL[info.kind]}</Badge>
        <span className="truncate">{schema}.{table}</span>
        {info.keySource === 'unique_index' && <Tooltip content={`Rows are identified by the unique index on (${info.keyColumns.join(', ')})`}><span>key: {info.keyColumns.join(', ')}</span></Tooltip>}
        <div className="flex-1" />
        <span className="tabular-nums">
          {shownFrom.toLocaleString()}–{shownTo.toLocaleString()} of{' '}
          <Tooltip content={exactTotal != null ? (exact?.key === queryKey ? `Exact count in ${formatDuration(exact.ms)}` : 'Exact') : 'Planner estimate — click Count for the exact number'}>
            <span className={cn('font-medium', exactTotal != null ? 'text-muted' : 'text-subtle')}>{totalLabel}</span>
          </Tooltip>
        </span>
        {exactTotal == null && (
          <Button size="xs" variant="ghost" loading={counting} onClick={() => void countExact()} className="h-5 px-1.5 text-[11px]">Count</Button>
        )}
        <div className="flex items-center">
          <IconButton size="xs" label="First page" disabled={page === 0} onClick={() => goPage(0)}><ChevronFirst size={13} /></IconButton>
          <IconButton size="xs" label="Previous page" disabled={page === 0} onClick={() => goPage(page - 1)}><ChevronLeft size={13} /></IconButton>
          <span className="px-1 tabular-nums text-muted">
            {page + 1}{lastPage != null && <span className="text-subtle"> / {(lastPage + 1).toLocaleString()}</span>}
          </span>
          <IconButton size="xs" label="Next page" disabled={!hasMore} onClick={() => goPage(page + 1)}><ChevronRight size={13} /></IconButton>
          <IconButton size="xs" label="Last page" disabled={!hasMore && lastPage != null && page >= lastPage} onClick={() => void goLast()}><ChevronLast size={13} /></IconButton>
        </div>
        <Select
          size="sm"
          className="w-[104px] [&_select]:h-5 [&_select]:py-0 [&_select]:text-[11px]"
          value={String(pageSize)}
          onChange={(e) => guard(() => { setParams({ pageSize: Number(e.target.value) }); setPage(0); })}
          options={[...new Set([...PAGE_SIZES, settingsPageSize])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} / page` }))}
        />
        <span className="w-14 text-right tabular-nums">{rowsQ.data ? formatDuration(rowsQ.data.durationMs) : ''}</span>
        {selRows > 1 && <span className="text-accent tabular-nums">{selRows.toLocaleString()} selected</span>}
      </div>
    </div>
  );
}
