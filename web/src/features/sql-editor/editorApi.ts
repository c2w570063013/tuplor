import type { HistoryEntry, HistoryInput, Snippet } from '@shared/completion';
import { api, http } from '@/lib/api';
import { useWorkspace, type Tab } from '@/stores/workspace';
import { queryClient } from '@/lib/queryClient';

const enc = encodeURIComponent;

export const editorApi = {
  history: (o: { q?: string; connId?: string; db?: string; errors?: 'only' | 'hide'; limit?: number }) => {
    const p = new URLSearchParams();
    if (o.q) p.set('q', o.q);
    if (o.connId) p.set('connId', o.connId);
    if (o.db) p.set('db', o.db);
    if (o.errors) p.set('errors', o.errors);
    p.set('limit', String(o.limit ?? 300));
    return http.get<HistoryEntry[]>(`/api/history?${p}`);
  },
  addHistory: (h: HistoryInput) => http.post<HistoryEntry>('/api/history', h),
  deleteHistory: (id: string) => http.del<{ ok: boolean }>(`/api/history/${enc(id)}`),
  clearHistory: () => http.del<{ ok: boolean }>('/api/history'),
  snippets: () => http.get<Snippet[]>('/api/snippets'),
  saveSnippet: (s: Partial<Snippet>) => http.post<Snippet>('/api/snippets', s),
  deleteSnippet: (id: string) => http.del<{ ok: boolean }>(`/api/snippets/${enc(id)}`),
};

export function recordHistory(h: HistoryInput) {
  editorApi
    .addHistory(h)
    .then(() => queryClient.invalidateQueries({ queryKey: ['sql-history'] }))
    .catch(() => { /* history is best effort */ });
}

// ---------------------------------------------------------------- session lifecycle

/** Close the server session of SQL tabs when they are closed. */
let watching = false;
export function watchEditorSessions() {
  if (watching) return;
  watching = true;
  const snapshot = (tabs: Tab[]) => {
    const m = new Map<string, { connId: string; sessionId: string }>();
    for (const t of tabs) if (t.kind === 'sql' && t.connId && t.params.sessionId) m.set(t.id, { connId: t.connId, sessionId: t.params.sessionId });
    return m;
  };
  let prev = snapshot(useWorkspace.getState().tabs);
  useWorkspace.subscribe((s) => {
    const next = snapshot(s.tabs);
    for (const [id, v] of prev) {
      const n = next.get(id);
      if (!n || n.sessionId !== v.sessionId) api.closeSession(v.connId, v.sessionId).catch(() => {});
    }
    prev = next;
  });
  window.addEventListener('pagehide', () => {
    // best effort: release server sessions when the window goes away
    for (const v of prev.values()) {
      try { navigator.sendBeacon?.(`/api/c/${enc(v.connId)}/sessions/${enc(v.sessionId)}/close`); } catch { /* ignore */ }
    }
  });
}
