import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonitorSnapshot } from '@shared/monitor';
import { ApiError } from '@/lib/api';
import { monitorApi } from './api';

/** Rolling window kept client-side. */
export const WINDOW_MS = 5 * 60_000;

/** One chart point: per-second rates between two consecutive snapshots + gauges. `null` = gap. */
export interface Sample {
  t: number;
  commits: number | null;
  rollbacks: number | null;
  tps: number | null;
  fetched: number | null;
  returned: number | null;
  inserted: number | null;
  updated: number | null;
  deleted: number | null;
  blksRead: number | null;
  blksHit: number | null;
  walRate: number | null;
  active: number | null;
  idle: number | null;
  idleInTx: number | null;
  waiting: number | null;
  other: number | null;
}

export interface LiveState {
  latest?: MonitorSnapshot;
  /** First snapshot seen since the dashboard was opened (for "since opened" deltas). */
  baseline?: MonitorSnapshot;
  samples: Sample[];
  error?: string;
  /** Client time of the last successful poll. */
  updatedAt?: number;
  loading: boolean;
}

const rate = (a: number, b: number, dt: number) => (b >= a ? (b - a) / dt : 0); // negative => stats reset

function toSample(prev: MonitorSnapshot, cur: MonitorSnapshot): Sample {
  const dt = Math.max(0.001, (cur.ts - prev.ts) / 1000);
  const p = prev.counters;
  const c = cur.counters;
  const commits = rate(p.xactCommit, c.xactCommit, dt);
  const rollbacks = rate(p.xactRollback, c.xactRollback, dt);
  return {
    t: cur.ts,
    commits,
    rollbacks,
    tps: commits + rollbacks,
    fetched: rate(p.tupFetched, c.tupFetched, dt),
    returned: rate(p.tupReturned, c.tupReturned, dt),
    inserted: rate(p.tupInserted, c.tupInserted, dt),
    updated: rate(p.tupUpdated, c.tupUpdated, dt),
    deleted: rate(p.tupDeleted, c.tupDeleted, dt),
    blksRead: rate(p.blksRead, c.blksRead, dt),
    blksHit: rate(p.blksHit, c.blksHit, dt),
    walRate: prev.walBytes != null && cur.walBytes != null ? rate(prev.walBytes, cur.walBytes, dt) : null,
    active: cur.connections.active,
    idle: cur.connections.idle,
    idleInTx: cur.connections.idleInTx,
    waiting: cur.connections.waiting,
    other: cur.connections.other,
  };
}

const gap = (t: number): Sample => ({
  t, commits: null, rollbacks: null, tps: null, fetched: null, returned: null, inserted: null, updated: null, deleted: null,
  blksRead: null, blksHit: null, walRate: null, active: null, idle: null, idleInTx: null, waiting: null, other: null,
});

/**
 * Poll the server snapshot every `intervalMs` while `enabled` (tab visible and not paused),
 * keeping a rolling 5-minute window of per-second rates. History survives pauses; a pause
 * shows up as a gap in the charts.
 */
export function useLiveSnapshots(connId: string | undefined, db: string | undefined, enabled: boolean, intervalMs: number) {
  const [state, setState] = useState<LiveState>({ samples: [], loading: true });
  const prevRef = useRef<MonitorSnapshot | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!connId || !enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;

    const tick = async () => {
      ctrl = new AbortController();
      try {
        const snap = await monitorApi.snapshot(connId, db, ctrl.signal);
        if (stopped) return;
        const prev = prevRef.current;
        prevRef.current = snap;
        setState((s) => {
          let samples = s.samples;
          if (prev) {
            const next: Sample[] = [];
            if (snap.ts - prev.ts > intervalMs * 2.5 + 1500) next.push(gap(prev.ts + 1));
            next.push(toSample(prev, snap));
            const cutoff = snap.ts - WINDOW_MS;
            samples = [...samples.filter((x) => x.t >= cutoff), ...next];
          }
          return { latest: snap, baseline: s.baseline ?? snap, samples, updatedAt: Date.now(), loading: false };
        });
      } catch (e) {
        if (stopped || (e as Error)?.name === 'AbortError') return;
        const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
        setState((s) => ({ ...s, error: msg, loading: false }));
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [connId, db, enabled, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}
