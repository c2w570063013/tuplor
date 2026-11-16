import { create } from 'zustand';
import type { ConnectionConfig, ServerInfo } from '@shared/types';
import { api, ApiError } from '@/lib/api';

export interface ConnState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  info?: ServerInfo;
  error?: string;
}

interface ConnectionsStore {
  list: ConnectionConfig[];
  loaded: boolean;
  state: Record<string, ConnState>;
  load: () => Promise<void>;
  save: (c: ConnectionConfig) => Promise<ConnectionConfig>;
  remove: (id: string) => Promise<void>;
  connect: (id: string) => Promise<ServerInfo | undefined>;
  disconnect: (id: string) => Promise<void>;
  /** Re-fetch server info (e.g. after CREATE DATABASE). */
  refresh: (id: string) => Promise<void>;
  get: (id: string | undefined) => ConnectionConfig | undefined;
}

export const useConnections = create<ConnectionsStore>((set, get) => ({
  list: [],
  loaded: false,
  state: {},
  async load() {
    const list = await api.listConnections();
    set({ list, loaded: true });
  },
  async save(c) {
    const saved = c.id ? await api.updateConnection(c) : await api.createConnection(c);
    await get().load();
    if (c.id) {
      // config changed -> server closed pools; reflect that
      set((s) => ({ state: { ...s.state, [c.id]: { status: 'idle' } } }));
    }
    return saved;
  },
  async remove(id) {
    await api.deleteConnection(id);
    set((s) => {
      const state = { ...s.state };
      delete state[id];
      return { state };
    });
    await get().load();
  },
  async connect(id) {
    const cur = get().state[id];
    if (cur?.status === 'connected') return cur.info;
    set((s) => ({ state: { ...s.state, [id]: { status: 'connecting' } } }));
    try {
      const info = await api.connect(id);
      set((s) => ({ state: { ...s.state, [id]: { status: 'connected', info } } }));
      return info;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      set((s) => ({ state: { ...s.state, [id]: { status: 'error', error: msg } } }));
      throw e;
    }
  },
  async disconnect(id) {
    await api.disconnect(id).catch(() => {});
    set((s) => ({ state: { ...s.state, [id]: { status: 'idle' } } }));
  },
  async refresh(id) {
    const info = await api.connect(id);
    set((s) => ({ state: { ...s.state, [id]: { status: 'connected', info } } }));
  },
  get(id) {
    return id ? get().list.find((c) => c.id === id) : undefined;
  },
}));
