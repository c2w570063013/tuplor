import type { ReactNode } from 'react';
import {
  AlertOctagon, ArrowRightLeft, Clock, Database, FileStack, Gauge, HardDrive, Layers, Plug, Server, Zap,
} from 'lucide-react';
import type { MonitorSnapshot } from '@shared/monitor';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { ChartCard, Sparkline, TimeSeries, type SeriesDef } from './charts';
import { ErrorState, formatPct, formatRate, formatSpan, LoadingState, MiniBar } from './common';
import type { LiveState, Sample } from './useLiveSnapshots';

const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';
const S3 = 'var(--series-3)';
const S4 = 'var(--series-4)';
const S5 = 'var(--series-5)';

const TPS: SeriesDef[] = [
  { key: 'commits', label: 'Commits', color: S1 },
  { key: 'rollbacks', label: 'Rollbacks', color: S2 },
];
const CONNS: SeriesDef[] = [
  { key: 'active', label: 'Active', color: S1 },
  { key: 'idleInTx', label: 'Idle in tx', color: S2 },
  { key: 'idle', label: 'Idle', color: S3 },
  { key: 'waiting', label: 'Waiting on lock', color: S4 },
  { key: 'other', label: 'Other', color: S5 },
];
const TUPLES: SeriesDef[] = [
  { key: 'fetched', label: 'Fetched', color: S1 },
  { key: 'inserted', label: 'Inserted', color: S2 },
  { key: 'updated', label: 'Updated', color: S3 },
  { key: 'deleted', label: 'Deleted', color: S4 },
];
const HITS: SeriesDef[] = [{ key: 'blksHit', label: 'Buffer hits', color: S1 }];
const READS: SeriesDef[] = [{ key: 'blksRead', label: 'Disk reads', color: S2 }];

export function shortVersion(s: MonitorSnapshot) {
  const v = s.versionNum;
  return v >= 100000 ? `${Math.floor(v / 10000)}.${v % 10000}` : `${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`;
}

const latest = (data: Sample[], k: keyof Sample): number | null => {
  for (let i = data.length - 1; i >= 0; i--) if (data[i][k] != null) return data[i][k] as number;
  return null;
};

export function Overview({ live, database }: { live: LiveState & { refresh: () => void }; database?: string }) {
  const s = live.latest;
  if (!s) {
    if (live.error) return <ErrorState error={new Error(live.error)} onRetry={live.refresh} />;
    return <LoadingState label="Reading server statistics…" />;
  }
  const data = live.samples;
  const base = live.baseline ?? s;
  const c = s.counters;
  const conn = s.connections;
  const usable = s.maxConnections;
  const connPct = (conn.total / usable) * 100;
  const hitTotal = c.blksHit + c.blksRead > 0 ? (100 * c.blksHit) / (c.blksHit + c.blksRead) : null;
  let wHit = 0;
  let wRead = 0;
  for (const x of data) { wHit += x.blksHit ?? 0; wRead += x.blksRead ?? 0; }
  const hitWindow = wHit + wRead > 0 ? (100 * wHit) / (wHit + wRead) : null;
  const rbPct = c.xactCommit + c.xactRollback > 0 ? (100 * c.xactRollback) / (c.xactCommit + c.xactRollback) : 0;
  const tps = latest(data, 'tps');
  const wal = latest(data, 'walRate');
  const newDeadlocks = c.deadlocks - base.counters.deadlocks;
  const newTemp = c.tempFiles - base.counters.tempFiles;

  let repValue: ReactNode = 'None';
  let repSub: ReactNode = 'No streaming replicas';
  let repTone: Tone = 'neutral';
  if (s.inRecovery) {
    repValue = s.replayLagSec == null ? 'Standby' : formatSpan(s.replayLagSec * 1000);
    repSub = 'Standby · replay lag';
    repTone = (s.replayLagSec ?? 0) > 60 ? 'warning' : 'neutral';
  } else if (s.replicas.length) {
    const maxBytes = Math.max(...s.replicas.map((r) => r.replayLagBytes ?? 0));
    const maxSec = Math.max(...s.replicas.map((r) => r.replayLagSec ?? 0));
    repValue = formatBytes(maxBytes);
    repSub = `${s.replicas.length} replica${s.replicas.length > 1 ? 's' : ''} · ${formatSpan(maxSec * 1000)} behind`;
    repTone = maxSec > 30 ? 'warning' : 'success';
  }

  return (
    <div className="pgs-viz flex flex-col gap-4 p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        <Kpi icon={<Server size={14} />} label="Server" value={`PostgreSQL ${shortVersion(s)}`} sub={<>Up {formatSpan(s.uptimeSec * 1000)}{s.inRecovery ? ' · standby' : ' · primary'}</>} title={s.version} />
        <Kpi
          icon={<Plug size={14} />}
          label="Connections"
          tone={connPct > 90 ? 'danger' : connPct > 75 ? 'warning' : 'neutral'}
          value={<>{conn.total}<span className="text-[13px] font-normal text-subtle"> / {usable}</span></>}
          sub={<>{conn.active} active · {conn.idle} idle{conn.idleInTx ? ` · ${conn.idleInTx} idle in tx` : ''}</>}
        >
          <MiniBar value={conn.total} max={usable} tone={connPct > 90 ? 'danger' : connPct > 75 ? 'warning' : 'accent'} className="mt-1" />
        </Kpi>
        <Kpi
          icon={<HardDrive size={14} />}
          label={database ? `Database size · ${database}` : 'Database size'}
          value={formatBytes(s.dbSizeBytes)}
          sub={<>{formatBytes(s.clusterSizeBytes)} across {s.databaseCount} databases</>}
        />
        <Kpi
          icon={<Gauge size={14} />}
          label="Cache hit ratio"
          tone={hitTotal != null && hitTotal < 90 ? 'warning' : 'neutral'}
          value={formatPct(hitTotal, 2)}
          sub={<>Last 5 min: {formatPct(hitWindow, 2)}</>}
        />
        <Kpi icon={<Zap size={14} />} label="Transactions / sec" value={tps == null ? '—' : formatRate(tps, '')} sub="Commits + rollbacks, all databases">
          <Sparkline data={data} k="tps" color={S1} />
        </Kpi>
        <Kpi
          icon={<ArrowRightLeft size={14} />}
          label="Commits vs rollbacks"
          tone={rbPct > 5 ? 'warning' : 'neutral'}
          value={formatPct(100 - rbPct, 2)}
          sub={<>{formatCount(c.xactCommit)} commits · {formatCount(c.xactRollback)} rollbacks</>}
        >
          <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-active">
            <div className="h-full bg-success" style={{ width: `${100 - rbPct}%` }} />
            <div className="h-full bg-danger" style={{ width: `${rbPct}%` }} />
          </div>
        </Kpi>
        <Kpi
          icon={<AlertOctagon size={14} />}
          label="Deadlocks"
          tone={newDeadlocks > 0 ? 'danger' : 'neutral'}
          value={formatCount(c.deadlocks)}
          sub={newDeadlocks > 0 ? `+${newDeadlocks} since opened` : 'None since dashboard opened'}
        />
        <Kpi
          icon={<FileStack size={14} />}
          label="Temp files"
          tone={newTemp > 0 ? 'warning' : 'neutral'}
          value={formatCount(c.tempFiles)}
          sub={<>{formatBytes(c.tempBytes)} spilled{newTemp > 0 ? ` · +${newTemp} since opened` : ''}</>}
        />
        <Kpi icon={<Layers size={14} />} label="WAL rate" value={wal == null ? '—' : `${formatBytes(wal)}/s`} sub={s.walBytes != null ? `${formatBytes(s.walBytes)} written in total` : 'WAL position unavailable'}>
          <Sparkline data={data} k="walRate" color={S2} />
        </Kpi>
        <Kpi icon={<Database size={14} />} label="Replication" tone={repTone} value={repValue} sub={repSub} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ChartCard title="Transactions per second" hint="All databases" series={TPS} data={data} format={(n) => formatRate(n, '')}>
          <TimeSeries data={data} series={TPS} format={(n) => `${formatRate(n, '')} tx/s`} />
        </ChartCard>
        <ChartCard title="Connections by state" hint="Client backends" series={CONNS} data={data} format={(n) => String(n)}>
          <TimeSeries data={data} series={CONNS} stacked format={(n) => String(n)} />
        </ChartCard>
        <ChartCard title="Tuples per second" hint="Rows fetched / written, all databases" series={TUPLES} data={data} format={(n) => formatRate(n, '')}>
          <TimeSeries data={data} series={TUPLES} kind="line" format={(n) => `${formatRate(n, '')}/s`} />
        </ChartCard>
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <ChartCard title="Buffer hits / s" hint="Blocks served from shared buffers" series={HITS} data={data} format={(n) => formatRate(n, '')}
            headline={<Headline value={latest(data, 'blksHit')} />}>
            <TimeSeries data={data} series={HITS} format={(n) => `${formatRate(n, '')} blocks/s`} />
          </ChartCard>
          <ChartCard title="Disk reads / s" hint="Blocks read from OS / disk" series={READS} data={data} format={(n) => formatRate(n, '')}
            headline={<Headline value={latest(data, 'blksRead')} />}>
            <TimeSeries data={data} series={READS} format={(n) => `${formatRate(n, '')} blocks/s`} />
          </ChartCard>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-subtle">
        <Clock size={11} />
        Rates are computed from cumulative counters between polls; charts keep a rolling 5-minute window while this tab is visible.
        {s.statsReset && <span>· Stats reset {new Date(s.statsReset.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toLocaleString()}</span>}
      </div>
    </div>
  );
}

function Headline({ value }: { value: number | null }) {
  return <div className="text-[15px] font-semibold text-fg tabular-nums">{value == null ? '—' : formatRate(value, '')}</div>;
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

function Kpi({
  icon, label, value, sub, children, tone = 'neutral', title,
}: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div
      title={title}
      className={cn(
        'relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-lg border bg-elevated px-3.5 pt-3 pb-3',
        tone === 'danger' ? 'border-danger/40' : tone === 'warning' ? 'border-warning/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted">
        <span className={cn(
          'flex h-5 w-5 items-center justify-center rounded-md',
          tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'warning' ? 'bg-warning-soft text-warning' : tone === 'success' ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent',
        )}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-[20px] leading-7 font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {sub && <div className="truncate text-[11px] text-subtle">{sub}</div>}
      {children}
    </div>
  );
}

