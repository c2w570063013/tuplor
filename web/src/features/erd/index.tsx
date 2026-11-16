import '@xyflow/react/dist/style.css';
import './erd.css';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Background, BackgroundVariant, MiniMap, getNodesBounds, getViewportForBounds, Panel, ReactFlow, ReactFlowProvider, useReactFlow, useViewport,
  type NodeChangeset, type EdgeTypes, type NodeTypes,
} from '@xyflow/react';
import {
  ChevronDown, ChevronUp, Download, Eye, KeyRound, LayoutDashboard, Map as MapIcon, Maximize, Minus, Network, Plus, RefreshCw, Search, X,
} from 'lucide-react';
import type { ErdResponse, ErdTable } from '@shared/erd';
import type { TabProps } from '../common/TabProps';
import { Button, DropdownMenu, EmptyState, IconButton, Input, Spinner, Toolbar, ToolbarDivider, toast } from '@/components/ui';
import { ApiError, dbUrl, http } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/stores/workspace';
import { adjacency, buildGraph, schemaColors, type RelationEdge as RelationEdgeT, type TableNode as TableNodeT } from './model';
import { layoutGraph, type Positions } from './layout';
import { TableNode, ErdActionsContext, type ErdActions } from './TableNode';
import { RelationEdge } from './RelationEdge';
import { SchemaFilter } from './SchemaFilter';
import { createErdUi, ErdUiContext } from './uiStore';
import { exportDiagram } from './exportImage';

const nodeTypes: NodeTypes = { table: TableNode as any };
const edgeTypes: EdgeTypes = { relation: RelationEdge as any };

export default function ErdTab(props: TabProps) {
  if (!props.tab.connId || !props.tab.database) {
    return <EmptyState icon={<Network size={28} />} title="No database selected" description="Open the ER diagram from a connected database." />;
  }
  return (
    <ReactFlowProvider>
      <ErdView {...props} />
    </ReactFlowProvider>
  );
}

// ------------------------------------------------------------ positions persistence

const posKey = (connId: string, db: string, schemas: string[], compact: boolean) =>
  `pgstudio.erd.v1:${connId}:${db}:${[...schemas].sort().join(',')}:${compact ? 'c' : 'f'}`;

function loadPositions(key: string): Positions {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}
function savePositions(key: string, pos: Positions) {
  try {
    localStorage.setItem(key, JSON.stringify(pos));
  } catch { /* quota: ignore */ }
}

// ------------------------------------------------------------ view

function ErdView({ tab, active }: TabProps) {
  const connId = tab.connId!;
  const db = tab.database!;
  const ws = useWorkspace.getState;
  const rf = useReactFlow<TableNodeT, RelationEdgeT>();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [ui] = useState(createErdUi);
  const pendingFit = useRef(false);

  const selectedSchemas: string[] | undefined = tab.params.schemas ?? (tab.params.schema ? [tab.params.schema] : undefined);
  const compact = !!tab.params.compact;
  const showViews = !!tab.params.views;
  const showMinimap = tab.params.minimap !== false;
  const setParams = (p: Record<string, any>) => ws().updateParams(tab.id, p);

  const q = useQuery({
    queryKey: ['erd', connId, db, selectedSchemas?.join(',') ?? '*', showViews],
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams();
      if (selectedSchemas) qs.set('schemas', selectedSchemas.join(','));
      if (showViews) qs.set('views', '1');
      return http.get<ErdResponse>(`${dbUrl(connId, db)}/erd?${qs}`, signal);
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const data = q.data;

  const colors = useMemo(() => schemaColors(data?.schemas.map((s) => s.name) ?? []), [data?.schemas]);
  const adj = useMemo(() => adjacency(data?.relations ?? []), [data?.relations]);
  const storageKey = posKey(connId, db, data?.included ?? [], compact);

  const [nodes, setNodes] = useState<TableNodeT[]>([]);
  const [edges, setEdges] = useState<RelationEdgeT[]>([]);
  const [layingOut, setLayingOut] = useState(false);
  const [exporting, setExporting] = useState(false);
  const onNodesChange = useCallback((changes: NodeChangeset<TableNodeT>) => setNodes((n) => changes.applyTo(n)), []);

  /**
   * Fit using our own geometry: with virtualization on, off-screen nodes are never measured,
   * so React Flow's fitView would only consider what's already visible.
   */
  const fitTo = useCallback(
    (list: TableNodeT[], duration = 350, padding: `${number}px` = '40px') => {
      const el = containerRef.current;
      if (!el || !list.length) return;
      if (!el.clientWidth || !el.clientHeight) {
        pendingFit.current = true; // hidden tab: fit once it becomes visible
        return;
      }
      pendingFit.current = false;
      const bounds = getNodesBounds(list.map((n) => ({ ...n, measured: { width: n.data.width, height: n.data.height } })));
      const vp = getViewportForBounds(bounds, el.clientWidth, el.clientHeight, 0.05, 1.1, padding);
      void rf.setViewport(vp, { duration });
    },
    [rf],
  );
  const fitAll = useCallback(() => fitTo(rf.getNodes(), 350), [fitTo, rf]);
  useEffect(() => {
    if (active && pendingFit.current) requestAnimationFrame(() => fitTo(rf.getNodes(), 0));
  }, [active, fitTo, rf]);

  // ---- build + layout whenever the data or compact mode changes
  const layoutSeq = useRef(0);
  const applyLayout = useCallback(
    async (opts: { reset?: boolean; animateFit?: boolean } = {}) => {
      if (!data) return;
      const seq = ++layoutSeq.current;
      const { nodes: base, edges: rels } = buildGraph(data, compact, colors);
      const saved = opts.reset ? {} : loadPositions(storageKey);
      const missing = base.filter((n) => !saved[n.id]);
      let pos: Positions = { ...saved };
      if (missing.length) {
        setLayingOut(true);
        try {
          const laid = await layoutGraph(missing, rels);
          if (missing.length === base.length) pos = laid;
          else {
            // new tables since the user arranged the diagram: place them below the existing ones
            let minX = Infinity;
            let maxY = -Infinity;
            for (const n of base) {
              const p = saved[n.id];
              if (!p) continue;
              minX = Math.min(minX, p.x);
              maxY = Math.max(maxY, p.y + n.data.height);
            }
            for (const [id, p] of Object.entries(laid)) pos[id] = { x: p.x + minX, y: p.y + maxY + 120 };
          }
        } catch (e) {
          toast.error(`Layout failed: ${e instanceof Error ? e.message : String(e)}`);
          base.forEach((n, i) => (pos[n.id] ??= { x: (i % 8) * 320, y: Math.floor(i / 8) * 360 }));
        } finally {
          if (seq === layoutSeq.current) setLayingOut(false);
        }
      }
      if (seq !== layoutSeq.current) return;
      if (opts.reset) savePositions(storageKey, pos);
      const placed = base.map((n) => ({ ...n, position: pos[n.id] ?? { x: 0, y: 0 } }));
      setNodes(placed);
      setEdges(rels);
      fitTo(placed, opts.animateFit ? 450 : 0);
    },
    [data, compact, colors, storageKey, fitTo],
  );


  useEffect(() => {
    void applyLayout();
  }, [applyLayout]);

  const persistPositions = useCallback(() => {
    const pos: Positions = {};
    for (const n of rf.getNodes()) pos[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    savePositions(storageKey, pos);
  }, [rf, storageKey]);

  // ---- highlight: hover > pinned (click) > search
  const [search, setSearch] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const [pinned, setPinned] = useState<string | null>(null);
  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s || !data) return [];
    const exact = data.tables.filter((t) => t.name.toLowerCase() === s || t.id.toLowerCase() === s);
    const partial = data.tables.filter((t) => !exact.includes(t) && (t.name.toLowerCase().includes(s) || t.id.toLowerCase().includes(s)));
    return [...exact, ...partial].map((t) => t.id);
  }, [search, data]);

  const highlightFor = useCallback(
    (ids: string[]) => {
      if (!ids.length) return { active: null, primary: new Set<string>() };
      const nodesSet = new Set(ids);
      const edgesSet = new Set<string>();
      for (const id of ids) {
        adj.nb.get(id)?.forEach((n) => nodesSet.add(n));
        adj.inc.get(id)?.forEach((e) => edgesSet.add(e));
      }
      return { active: { nodes: nodesSet, edges: edgesSet }, primary: new Set(ids) };
    },
    [adj],
  );
  const baseHighlight = useCallback(() => {
    if (pinned) return highlightFor([pinned]);
    if (search.trim()) {
      if (!matches.length) return { active: { nodes: new Set<string>(), edges: new Set<string>() }, primary: new Set<string>() };
      return highlightFor(matches);
    }
    return { active: null, primary: new Set<string>() };
  }, [pinned, search, matches, highlightFor]);

  useEffect(() => {
    ui.getState().set(baseHighlight());
  }, [baseHighlight, ui]);

  const centerOn = useCallback(
    (id: string) => {
      const n = rf.getNode(id);
      if (!n) return;
      const zoom = Math.max(rf.getZoom(), 0.85);
      void rf.setCenter(n.position.x + n.data.width / 2, n.position.y + Math.min(n.data.height, 400) / 2, { zoom, duration: 400 });
    },
    [rf],
  );

  useEffect(() => {
    setMatchIdx(0);
    if (matches.length) centerOn(matches[0]);
  }, [matches, centerOn]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && matches.length) {
      const next = (matchIdx + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
      setMatchIdx(next);
      centerOn(matches[next]);
    } else if (e.key === 'Escape') {
      setSearch('');
      searchRef.current?.blur();
    }
  };

  // ⌘F focuses the diagram search while this tab is visible
  useEffect(() => {
    if (!active) return;
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active]);

  // ---- actions
  const actions = useMemo<ErdActions>(
    () => ({
      openData: (t: ErdTable) =>
        ws().openTab({
          kind: 'table-data', title: t.name, connId, database: db,
          key: `data:${connId}:${db}:${t.schema}.${t.name}`,
          params: { schema: t.schema, table: t.name, objectKind: t.kind },
        }),
      openStructure: (t: ErdTable) =>
        ws().openTab({
          kind: 'structure', title: `${t.name} · structure`, connId, database: db,
          key: `struct:${connId}:${db}:${t.schema}.${t.name}`,
          params: { schema: t.schema, table: t.name, objectKind: t.kind },
        }),
      focusTable: (id: string) => {
        setPinned(id);
        const ids = [id, ...(adj.nb.get(id) ?? [])];
        fitTo(rf.getNodes().filter((n) => ids.includes(n.id)), 450, '80px');
      },
    }),
    [connId, db, adj, rf, fitTo],
  );

  const doExport = async (format: 'png' | 'svg') => {
    if (!containerRef.current) return;
    setExporting(true);
    ui.getState().set({ active: null, primary: new Set(), hoveredEdge: null, hotColumns: new Set() });
    try {
      // let React render every node (virtualization off) before snapshotting
      await new Promise((r) => setTimeout(r, 120));
      await exportDiagram(containerRef.current, rf.getNodes(), format, `${db}-erd`);
      toast.success(`Exported ${format.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
      ui.getState().set(baseHighlight());
    }
  };

  const err = q.error instanceof ApiError ? q.error.message : q.error ? String(q.error) : null;
  const virtualize = nodes.length > 60 && !exporting;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <SchemaFilter
          schemas={data?.schemas ?? []}
          selected={data?.included ?? selectedSchemas ?? []}
          colors={colors}
          onChange={(s) => setParams({ schemas: s, schema: undefined })}
        />
        <IconButton label={showViews ? 'Hide views' : 'Show views & materialized views'} active={showViews} onClick={() => setParams({ views: !showViews })}>
          <Eye size={15} />
        </IconButton>
        <IconButton label={compact ? 'Show all columns' : 'Compact: key columns only'} active={compact} onClick={() => setParams({ compact: !compact })}>
          <KeyRound size={15} />
        </IconButton>
        <ToolbarDivider />
        <div className="relative">
          <Input
            ref={searchRef}
            size="sm"
            icon={<Search size={13} />}
            placeholder="Find table…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPinned(null); }}
            onKeyDown={onSearchKey}
            className="w-56"
          />
          {search && (
            <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
              <span className="px-1 text-[10.5px] text-subtle tabular-nums">
                {matches.length ? `${matchIdx + 1}/${matches.length}` : '0'}
              </span>
              <IconButton size="xs" label="Previous (⇧↵)" onClick={() => onSearchKey({ key: 'Enter', shiftKey: true } as any)}>
                <ChevronUp size={12} />
              </IconButton>
              <IconButton size="xs" label="Next (↵)" onClick={() => onSearchKey({ key: 'Enter', shiftKey: false } as any)}>
                <ChevronDown size={12} />
              </IconButton>
              <IconButton size="xs" label="Clear" onClick={() => setSearch('')}>
                <X size={12} />
              </IconButton>
            </div>
          )}
        </div>
        <ToolbarDivider />
        <Button size="sm" variant="ghost" icon={<LayoutDashboard size={14} />} onClick={() => void applyLayout({ reset: true, animateFit: true })} disabled={!data || layingOut}>
          Auto layout
        </Button>
        <IconButton label="Fit to screen" onClick={fitAll}>
          <Maximize size={15} />
        </IconButton>
        <IconButton label={showMinimap ? 'Hide minimap' : 'Show minimap'} active={showMinimap} onClick={() => setParams({ minimap: !showMinimap })}>
          <MapIcon size={15} />
        </IconButton>
        <DropdownMenu
          align="end"
          trigger={
            <Button size="sm" variant="ghost" icon={<Download size={14} />} disabled={!nodes.length} loading={exporting}>
              Export
            </Button>
          }
          items={[
            { label: 'PNG image', onSelect: () => void doExport('png') },
            { label: 'SVG image', onSelect: () => void doExport('svg') },
          ]}
        />
        <div className="flex-1" />
        {data && (
          <span className="mr-1 text-[11.5px] text-subtle tabular-nums">
            {data.tables.length} tables · {data.relations.length} relations
            {data.externalRelations > 0 && <> · {data.externalRelations} to other schemas</>}
          </span>
        )}
        <IconButton label="Reload" onClick={() => void q.refetch()}>
          <RefreshCw size={14} className={cn(q.isFetching && 'animate-spin')} />
        </IconButton>
      </Toolbar>

      <div ref={containerRef} className="relative min-h-0 flex-1">
        {err ? (
          <EmptyState
            icon={<Network size={28} />}
            title="Couldn't load the diagram"
            description={err}
            action={<Button onClick={() => void q.refetch()}>Retry</Button>}
          />
        ) : !data ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted">
            <Spinner /> Reading catalog…
          </div>
        ) : !data.tables.length ? (
          <EmptyState
            icon={<Network size={28} />}
            title={data.included.length ? 'No tables in the selected schemas' : 'No schema selected'}
            description={data.included.length ? 'Try including views or picking other schemas.' : 'Pick one or more schemas to draw.'}
          />
        ) : (
          <ErdUiContext.Provider value={ui}>
            <ErdActionsContext.Provider value={actions}>
              <ReactFlow<TableNodeT, RelationEdgeT>
                className="erd-flow"
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onNodeDragStop={persistPositions}
                onNodeDoubleClick={(_, n) => actions.openData(n.data.table)}
                onNodeClick={(_, n) => setPinned((p) => (p === n.id ? null : n.id))}
                onPaneClick={() => setPinned(null)}
                onNodeMouseEnter={(_, n) => ui.getState().set(highlightFor([n.id]))}
                onNodeMouseLeave={() => ui.getState().set(baseHighlight())}
                onEdgeMouseEnter={(_, e) => {
                  const r = e.data!.rel;
                  ui.getState().set({
                    hoveredEdge: e.id,
                    hotColumns: new Set([
                      ...r.sourceColumns.map((c) => `${r.source}\u0000${c}`),
                      ...r.targetColumns.map((c) => `${r.target}\u0000${c}`),
                    ]),
                  });
                }}
                onEdgeMouseLeave={() => ui.getState().set({ hoveredEdge: null, hotColumns: new Set() })}
                nodesConnectable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                zoomOnDoubleClick={false}
                onlyRenderVisibleElements={virtualize}
                minZoom={0.05}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
                {showMinimap && (
                  <MiniMap<TableNodeT>
                    pannable
                    zoomable
                    nodeColor={(n) => n.data.color}
                    nodeBorderRadius={4}
                    position="bottom-right"
                    style={{ width: 180, height: 120 }}
                  />
                )}
                <ZoomControls onFit={fitAll} />
                <Legend />
              </ReactFlow>
            </ErdActionsContext.Provider>
          </ErdUiContext.Provider>
        )}
        {layingOut && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-muted shadow-pop">
              <Spinner size={13} /> Laying out {data?.tables.length} tables…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ZoomControls({ onFit }: { onFit: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="bottom-left" className="!m-3">
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-elevated p-0.5 shadow-pop">
        <IconButton label="Zoom out" size="sm" onClick={() => void rf.zoomOut({ duration: 150 })} tooltipSide="top">
          <Minus size={14} />
        </IconButton>
        <button
          className="h-7 w-12 rounded-md text-[11px] font-medium text-muted tabular-nums hover:bg-hover hover:text-fg"
          onClick={() => void rf.zoomTo(1, { duration: 200 })}
          title="Reset to 100%"
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" size="sm" onClick={() => void rf.zoomIn({ duration: 150 })} tooltipSide="top">
          <Plus size={14} />
        </IconButton>
        <div className="mx-0.5 h-4 w-px bg-border" />
        <IconButton label="Fit to screen" size="sm" onClick={onFit} tooltipSide="top">
          <Maximize size={14} />
        </IconButton>
      </div>
    </Panel>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  const stroke = { fill: 'none', stroke: 'var(--muted)', strokeWidth: 1.4, strokeLinecap: 'round' as const };
  return (
    <Panel position="top-right" className="!m-3">
      {open ? (
        <div className="w-56 rounded-lg border border-border bg-elevated p-2.5 text-[11.5px] text-muted shadow-pop">
          <div className="mb-1.5 flex items-center justify-between font-medium text-fg">
            Legend
            <IconButton size="xs" label="Close legend" onClick={() => setOpen(false)}><X size={12} /></IconButton>
          </div>
          <div className="grid grid-cols-[34px_1fr] items-center gap-x-2 gap-y-1.5">
            <svg width="34" height="14"><path d="M2 7 H32 M14 7 L2 1 M14 7 L2 13" style={stroke} /><circle cx="21" cy="7" r="3.4" style={{ ...stroke, fill: 'var(--elevated)' }} /></svg>
            <span>zero or many (FK side)</span>
            <svg width="34" height="14"><path d="M2 7 H32 M10 1 V13" style={stroke} /><circle cx="19" cy="7" r="3.4" style={{ ...stroke, fill: 'var(--elevated)' }} /></svg>
            <span>zero or one (unique FK)</span>
            <svg width="34" height="14"><path d="M2 7 H32 M24 1 V13 M19 1 V13" style={stroke} /></svg>
            <span>exactly one (referenced)</span>
            <svg width="34" height="14"><path d="M2 7 H32 M24 1 V13" style={stroke} /><circle cx="15" cy="7" r="3.4" style={{ ...stroke, fill: 'var(--elevated)' }} /></svg>
            <span>zero or one (nullable FK)</span>
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[11px] text-subtle">
            Hover a table to trace its relations, click to pin, double-click to open its data. Drag to rearrange — positions are remembered.
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="rounded-md border border-border bg-elevated px-2 py-1 text-[11px] font-medium text-muted shadow-sm hover:text-fg"
        >
          Legend
        </button>
      )}
    </Panel>
  );
}
