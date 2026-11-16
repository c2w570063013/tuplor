import { useId, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { WINDOW_MS, type Sample } from './useLiveSnapshots';

export interface SeriesDef {
  key: keyof Sample;
  label: string;
  /** CSS color, e.g. var(--series-1). Assign slots in fixed order. */
  color: string;
}

/** Round up to a "nice" axis maximum (1, 2, 2.5, 5 × 10^k) so ticks land on round numbers. */
export function niceCeil(max: number): number {
  if (!(max > 0)) return 4;
  const v = max * 1.08;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 4, 5, 8, 10]) if (m * p >= v) return Math.max(4, m * p);
  return 10 * p;
}

const timeFmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function lastValue(data: Sample[], key: keyof Sample): number | null {
  for (let i = data.length - 1; i >= 0; i--) {
    const v = data[i][key];
    if (v != null) return v as number;
  }
  return null;
}

/** Card wrapper for one chart: title, legend with live values, plot. */
export function ChartCard({
  title, hint, series, data, format, children, className, headline,
}: {
  title: string;
  hint?: string;
  series: SeriesDef[];
  data: Sample[];
  format: (n: number) => string;
  children: ReactNode;
  className?: string;
  headline?: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col rounded-lg border border-border bg-elevated', className)}>
      <div className="flex items-start justify-between gap-3 px-4 pt-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-fg">{title}</div>
          {hint && <div className="text-[11px] text-subtle">{hint}</div>}
        </div>
        {headline}
      </div>
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-2">
          {series.map((s) => {
            const v = lastValue(data, s.key);
            return (
              <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                {s.label}
                <span className="font-medium text-fg tabular-nums">{v == null ? '—' : format(v)}</span>
              </span>
            );
          })}
        </div>
      )}
      <div className="relative h-[170px] px-1 pt-2 pb-1">{children}</div>
    </div>
  );
}

function ChartTooltip({ active, payload, label, series, format }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as Sample | undefined;
  if (!point) return null;
  return (
    <div className="min-w-[150px] rounded-md border border-border bg-elevated px-2.5 py-2 text-[11.5px] shadow-pop">
      <div className="mb-1 text-[10.5px] text-subtle tabular-nums">{timeFmt(label)}</div>
      {(series as SeriesDef[]).map((s) => {
        const v = point[s.key] as number | null;
        return (
          <div key={s.key} className="flex items-center gap-2 py-px">
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
            <span className="flex-1 text-muted">{s.label}</span>
            <span className="font-medium text-fg tabular-nums">{v == null ? '—' : format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Live time-series over the rolling 5-minute window. */
export function TimeSeries({
  data, series, format, stacked, kind = 'area', yTick = (n: number) => formatCount(n),
}: {
  data: Sample[];
  series: SeriesDef[];
  format: (n: number) => string;
  stacked?: boolean;
  kind?: 'area' | 'line';
  yTick?: (n: number) => string;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const end = data.length ? data[data.length - 1].t : Date.now();
  const start = end - WINDOW_MS;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / 60_000) * 60_000; t <= end; t += 60_000) ticks.push(t);

  if (data.length < 1) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[11.5px] text-subtle">
        <Spinner size={12} /> Collecting samples…
      </div>
    );
  }

  const common = {
    data,
    margin: { top: 4, right: 12, bottom: 0, left: 0 },
  };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
      <XAxis
        dataKey="t"
        type="number"
        domain={[start, end]}
        ticks={ticks}
        tickFormatter={shortTime}
        tick={{ fill: 'var(--viz-axis)', fontSize: 10.5 }}
        axisLine={{ stroke: 'var(--border)' }}
        tickLine={false}
        allowDataOverflow
      />
      <YAxis
        width={44}
        tickFormatter={yTick}
        tick={{ fill: 'var(--viz-axis)', fontSize: 10.5 }}
        axisLine={false}
        tickLine={false}
        allowDecimals={false}
        tickCount={5}
        domain={[0, niceCeil]}
      />
      <Tooltip
        isAnimationActive={false}
        cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
        content={<ChartTooltip series={series} format={format} />}
      />
    </>
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      {kind === 'line' ? (
        <LineChart {...common}>
          {axes}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--elevated)' }}
              isAnimationActive={false}
              type="monotone"
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart {...common}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`g${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={stacked ? 0.55 : 0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={stacked ? 0.35 : 0.02} />
              </linearGradient>
            ))}
          </defs>
          {axes}
          {(stacked ? series.filter((s) => data.some((d) => (d[s.key] as number | null) ?? 0) ) : series).map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'a' : undefined}
              stroke={s.color}
              strokeWidth={stacked ? 1.5 : 2}
              fill={`url(#g${gid}-${s.key})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--elevated)' }}
              isAnimationActive={false}
              type={stacked ? 'stepAfter' : 'monotone'}
            />
          ))}
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}

/** Tiny inline sparkline for KPI cards (single series, no axes). */
export function Sparkline({ data, k, color = 'var(--series-1)' }: { data: Sample[]; k: keyof Sample; color?: string }) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');
  if (data.length < 2) return <div className="h-8" />;
  return (
    <div className="h-8 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`sp${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, (max: number) => (max <= 0 ? 1 : max * 1.15)]} />
          <XAxis hide dataKey="t" type="number" domain={['dataMin', 'dataMax']} />
          <Area dataKey={k} stroke={color} strokeWidth={1.5} fill={`url(#sp${gid})`} dot={false} isAnimationActive={false} type="monotone" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
