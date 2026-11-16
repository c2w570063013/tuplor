import { create } from 'zustand';

/** Expanded / selected state of the explorer tree (expanded keys persisted in localStorage). */
const LS_KEY = 'pgstudio.explorer.expanded';

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

interface TreeStore {
  expanded: Set<string>;
  selected: string | null;
  toggle: (key: string, force?: boolean) => void;
  select: (key: string | null) => void;
  /** Collapse every node below the given key prefix. */
  collapseAll: () => void;
}

export const useTree = create<TreeStore>((set) => ({
  expanded: load(),
  selected: null,
  toggle(key, force) {
    set((s) => {
      const next = new Set(s.expanded);
      const on = force ?? !next.has(key);
      if (on === next.has(key)) return s;
      if (on) next.add(key);
      else next.delete(key);
      try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return { expanded: next };
    });
  },
  select(key) {
    set({ selected: key });
  },
  collapseAll() {
    set((s) => {
      const next = new Set([...s.expanded].filter((k) => k.startsWith('c:')));
      try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return { expanded: next };
    });
  },
}));

export const useExpanded = (key: string) => useTree((s) => s.expanded.has(key));
