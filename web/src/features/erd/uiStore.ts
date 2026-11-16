import { createContext, useContext } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * Per-diagram highlight state. Nodes/edges subscribe with narrow selectors, so hovering a
 * table only re-renders the elements whose highlight state actually changes.
 */
export interface ErdUiState {
  /** Highlighted set (hover or search). null = nothing highlighted, everything at full opacity. */
  active: { nodes: Set<string>; edges: Set<string> } | null;
  /** Tables emphasised as primary (hovered table, search matches). */
  primary: Set<string>;
  /** Hovered relation id (shows its label and highlights its columns). */
  hoveredEdge: string | null;
  /** "tableId\0column" keys highlighted because of the hovered edge. */
  hotColumns: Set<string>;
  set: (patch: Partial<Omit<ErdUiState, 'set'>>) => void;
}

export const createErdUi = () =>
  createStore<ErdUiState>((set) => ({
    active: null,
    primary: new Set(),
    hoveredEdge: null,
    hotColumns: new Set(),
    set: (patch) => set(patch),
  }));

export const ErdUiContext = createContext<StoreApi<ErdUiState> | null>(null);

export function useErdUi<T>(selector: (s: ErdUiState) => T): T {
  const store = useContext(ErdUiContext);
  if (!store) throw new Error('ErdUiContext missing');
  return useStore(store, selector);
}

/** 2 = no highlight active, 1 = highlighted, 0 = dimmed */
export type HiState = 0 | 1 | 2;
