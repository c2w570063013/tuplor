import { useCallback, type ReactNode } from 'react';
import { Activity, BarChart3, Database, Gauge, HardDrive, Lock, Pause, Play, RefreshCw, SlidersHorizontal, Unplug } from 'lucide-react';
import { EmptyState, IconButton, Select, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { queryClient } from '@/lib/queryClient';
import { useConnections } from '@/stores/connections';
import { useWorkspace } from '@/stores/workspace';
import type { TabProps } from '../common/TabProps';
import { ActivityView } from './Activity';
import { formatSpan, useNow } from './common';
import { DatabasesView } from './Databases';
import { LocksView } from './Locks';
import { Overview } from './Overview';
import { SettingsView } from './Settings';
import { StatementsView } from './Statements';
import { StorageView } from './Storage';
import type { SectionProps } from './types';
import { useLiveSnapshots } from './useLiveSnapshots';
import './viz.css';

type Section = 'overview' | 'activity' | 'locks' | 'storage' | 'statements' | 'settings' | 'databases';

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={14} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={14} /> },
  { id: 'locks', label: 'Locks', icon: <Lock size={14} /> },
  { id: 'storage', label: 'Tables & indexes', icon: <HardDrive size={14} /> },
  { id: 'statements', label: 'Query stats', icon: <BarChart3 size={14} /> },
  { id: 'settings', label: 'Configuration', icon: <SlidersHorizontal size={14} /> },
  { id: 'databases', label: 'Databases', icon: <Database size={14} /> },
];

const INTERVALS = [1000, 2000, 5000, 10_000, 30_000];

export default function DashboardTab({ tab, active }: TabProps) {
  const connId = tab.connId;
  const database = tab.database ?? useConnections.getState().get(connId)?.database ?? 'postgres';
  const section: Section = tab.params.section ?? 'overview';
  const intervalMs: number = tab.params.intervalMs ?? 2000;
  const paused: boolean = tab.params.paused ?? false;
  const setParams = useCallback((patch: Record<string, any>) => useWorkspace.getState().updateParams(tab.id, patch), [tab.id]);

  const live = active && !paused;
  const snaps = useLiveSnapshots(connId, database, live, intervalMs);

  if (!connId) {
    return <EmptyState icon={<Unplug size={28} />} title="No connection" description="Open the dashboard from a connected server." />;
  }

  const latest = snaps.latest;
  const counts: Partial<Record<Section, { n: number; tone: 'accent' | 'danger' }>> = latest
    ? {
        activity: latest.connections.active > 0 ? { n: latest.connections.active, tone: 'accent' } : undefined,
        locks: latest.connections.waiting > 0 ? { n: latest.connections.waiting, tone: 'danger' } : undefined,
      }
    : {};

  const props: SectionProps = { connId, database, live, intervalMs, params: tab.params, setParams };
  const refreshAll = () => {
    snaps.refresh();
    queryClient.invalidateQueries({ queryKey: ['monitor', connId] });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {SECTIONS.map((s) => {
            const c = counts[s.id];
            const on = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setParams({ section: s.id })}
                className={cn(
                  'relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
                  on ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <span className={on ? 'text-accent' : 'text-subtle'}>{s.icon}</span>
                {s.label}
                {c && (
                  <span className={cn(
                    'ml-0.5 min-w-[18px] rounded-full px-1.5 text-center text-[10.5px] leading-4 font-semibold tabular-nums',
                    c.tone === 'danger' ? 'bg-danger text-white' : 'bg-accent-soft text-accent',
                  )}>
                    {c.n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="flex-1" />
        <LiveIndicator live={live} paused={paused} active={active} error={snaps.error} updatedAt={snaps.updatedAt} />
        <Select
          size="sm"
          className="w-[84px] shrink-0"
          aria-label="Refresh interval"
          value={String(intervalMs)}
          onChange={(e) => setParams({ intervalMs: Number(e.target.value) })}
          options={INTERVALS.map((ms) => ({ value: String(ms), label: ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000}m` }))}
        />
        <IconButton label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'} onClick={() => setParams({ paused: !paused })} active={paused}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </IconButton>
        <IconButton label="Refresh now" onClick={refreshAll}><RefreshCw size={14} /></IconButton>
      </div>
      <div className={cn('min-h-0 flex-1', section === 'overview' ? 'overflow-auto' : 'overflow-hidden')}>
        {section === 'overview' && <Overview live={snaps} database={database} />}
        {section === 'activity' && <ActivityView {...props} />}
        {section === 'locks' && <LocksView {...props} />}
        {section === 'storage' && <StorageView {...props} />}
        {section === 'statements' && <StatementsView {...props} />}
        {section === 'settings' && <SettingsView {...props} />}
        {section === 'databases' && <DatabasesView {...props} />}
      </div>
    </div>
  );
}

function LiveIndicator({ live, paused, active, error, updatedAt }: { live: boolean; paused: boolean; active: boolean; error?: string; updatedAt?: number }) {
  const now = useNow(active);
  const ago = updatedAt ? Math.max(0, now - updatedAt) : null;
  return (
    <Tooltip content={error ? `Last poll failed: ${error}` : paused ? 'Auto-refresh paused' : active ? 'Live — polling while this tab is visible' : 'Paused while the tab is hidden'}>
      <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted">
        <span className="relative flex h-2 w-2">
          {live && !error && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
          <span className={cn('relative inline-flex h-2 w-2 rounded-full', error ? 'bg-danger' : live ? 'bg-success' : 'bg-subtle')} />
        </span>
        {error ? 'Error' : paused ? 'Paused' : 'Live'}
        {ago != null && <span className="text-subtle tabular-nums">· {ago < 1500 ? 'just now' : `${formatSpan(ago)} ago`}</span>}
      </span>
    </Tooltip>
  );
}
