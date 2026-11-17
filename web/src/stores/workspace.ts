import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uid } from '@/lib/format';

/**
 * Tabs. Every feature view is a tab of a given `kind`; see features/registry.tsx.
 * Params by kind (convention):
 *   sql:          { sql?: string, fileName?: string }
 *   table-data:   { schema, table, objectKind? }
 *   structure:    { schema, table, objectKind?, section? }      (view/edit table structure, DDL)
 *   create-table: { schema }
 *   object:       { schema, name, objectKind, oid?, args? }     (view/function/sequence/type DDL viewer)
 *   dashboard:    {}                                              (server monitor for connId)
 *   roles:        { role? }
 *   erd:          { schema? }
 *   backup:       { mode?: 'backup' | 'restore' }
 *   import:       { schema?, table? }
 *   explain:      { sql, plan?: any, analyze?: boolean }
 */
export type TabKind =
  | 'welcome' | 'sql' | 'table-data' | 'structure' | 'create-table' | 'object'
  | 'dashboard' | 'roles' | 'erd' | 'backup' | 'import' | 'explain' | 'settings';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  connId?: string;
  database?: string;
  params: Record<string, any>;
  /** Unsaved changes indicator (dot in tab bar, confirm on close). */
  dirty?: boolean;
  /** Tabs with the same key are de-duplicated by openTab (focus existing instead). */
  key?: string;
  /** "Preview" tabs (single-click in explorer) get replaced by the next preview. */
  preview?: boolean;
}

export type OpenTabInput = Omit<Tab, 'id' | 'params'> & { params?: Record<string, any> };

interface WorkspaceStore {
  tabs: Tab[];
  activeTabId: string | null;
  /** The connection/database the user is "in" (sidebar selection; default for new queries). */
  activeConnId: string | null;
  activeDb: string | null;
  sidebarCollapsed: boolean;
  openTab: (t: OpenTabInput) => string;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Omit<Tab, 'id'>>) => void;
  updateParams: (id: string, patch: Record<string, any>) => void;
  moveTab: (from: number, to: number) => void;
  pinTab: (id: string) => void;
  setActiveDb: (connId: string | null, db: string | null) => void;
  toggleSidebar: () => void;
  /** Open a new SQL editor for the given (or active) connection/db. */
  newQuery: (opts?: { connId?: string; database?: string; sql?: string; title?: string }) => string | null;
}

let queryCounter = 1;

export const useWorkspace = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      activeConnId: null,
      activeDb: null,
      sidebarCollapsed: false,

      openTab(input) {
        const { tabs } = get();
        if (input.key) {
          const existing = tabs.find((t) => t.key === input.key);
          if (existing) {
            set({
              activeTabId: existing.id,
              tabs: tabs.map((t) =>
                t.id === existing.id ? { ...t, params: { ...t.params, ...input.params }, preview: input.preview ? t.preview : false } : t,
              ),
            });
            return existing.id;
          }
        }
        const tab: Tab = { ...input, id: uid('t'), params: input.params ?? {} };
        let next = [...tabs];
        const activeIdx = next.findIndex((t) => t.id === get().activeTabId);
        if (input.preview) {
          const pi = next.findIndex((t) => t.preview && !t.dirty);
          if (pi >= 0) {
            next[pi] = tab;
            set({ tabs: next, activeTabId: tab.id });
            return tab.id;
          }
        }
        next.splice(activeIdx >= 0 ? activeIdx + 1 : next.length, 0, tab);
        set({ tabs: next, activeTabId: tab.id });
        return tab.id;
      },
      closeTab(id) {
        const { tabs, activeTabId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const next = tabs.filter((t) => t.id !== id);
        let active = activeTabId;
        if (activeTabId === id) active = next[Math.min(idx, next.length - 1)]?.id ?? null;
        set({ tabs: next, activeTabId: active });
      },
      closeOthers(id) {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeTabId: id }));
      },
      closeAll() {
        set({ tabs: [], activeTabId: null });
      },
      setActiveTab(id) {
        set({ activeTabId: id });
      },
      updateTab(id, patch) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
      },
      updateParams(id, patch) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, params: { ...t.params, ...patch } } : t)) }));
      },
      moveTab(from, to) {
        set((s) => {
          const tabs = [...s.tabs];
          const [t] = tabs.splice(from, 1);
          tabs.splice(to, 0, t);
          return { tabs };
        });
      },
      pinTab(id) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) }));
      },
      setActiveDb(connId, db) {
        set({ activeConnId: connId, activeDb: db });
      },
      toggleSidebar() {
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
      },
      newQuery(opts = {}) {
        const connId = opts.connId ?? get().activeConnId;
        const database = opts.database ?? get().activeDb;
        if (!connId || !database) return null;
        const n = queryCounter++;
        return get().openTab({
          kind: 'sql',
          title: opts.title ?? `Query ${n}`,
          connId,
          database,
          params: { sql: opts.sql ?? '' },
        });
      },
    }),
    {
      name: 'tuplor.workspace',
      version: 1,
      partialize: (s) => ({
        tabs: s.tabs.filter((t) => t.kind !== 'explain'),
        activeTabId: s.activeTabId,
        activeConnId: s.activeConnId,
        activeDb: s.activeDb,
        sidebarCollapsed: s.sidebarCollapsed,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) queryCounter = state.tabs.filter((t) => t.kind === 'sql').length + 1;
      },
    },
  ),
);

/** Helper: is a tab currently the active one? */
export const useIsActiveTab = (id: string) => useWorkspace((s) => s.activeTabId === id);
