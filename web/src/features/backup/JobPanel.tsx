import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './backup.css';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArchiveRestore, CheckCircle2, CircleSlash, Copy, Download, FileArchive, HardDrive, Square, Timer, XCircle, ScrollText,
} from 'lucide-react';
import type { JobInfo, LogLine } from '@shared/backup';
import { Badge, Button, EmptyState, IconButton, Spinner, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatDuration } from '@/lib/format';
import { backupApi, FORMAT_LABEL } from './api';

const MAX_LINES = 4000;

export function JobPanel({ jobId, onRestoreFile }: { jobId: string | null; onRestoreFile: (file: string) => void }) {
  const qc = useQueryClient();
  const [job, setJob] = useState<JobInfo | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<'all' | 'errors'>('all');
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setJob(null);
    setLines([]);
    stick.current = true;
    if (!jobId) return;
    let since = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await backupApi.job(jobId, since);
        if (stopped) return;
        since = r.next;
        setJob(r.job);
        if (r.lines.length) setLines((prev) => {
          const next = prev.concat(r.lines);
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
        if (r.job.status === 'running') timer = setTimeout(tick, 400);
        else {
          void qc.invalidateQueries({ queryKey: ['backup-files'] });
          void qc.invalidateQueries({ queryKey: ['backup-jobs'] });
        }
      } catch {
        if (!stopped) timer = setTimeout(tick, 1500);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [jobId, qc]);

  // live elapsed clock
  useEffect(() => {
    if (job?.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [job?.status]);

  // auto-scroll unless the user scrolled up
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, filter]);

  if (!jobId) {
    return (
      <EmptyState
        icon={<ScrollText size={26} />}
        title="No job running"
        description="Start a backup or restore — its live log, progress and summary appear here."
      />
    );
  }
  if (!job) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner /> Loading job…
      </div>
    );
  }

  const running = job.status === 'running';
  const elapsed = running ? now - Date.parse(job.startedAt) : job.durationMs;
  const shown = filter === 'errors' ? lines.filter((l) => l.level === 'error' || l.level === 'warning') : lines;
  const tone = job.status === 'success' ? 'text-success' : job.status === 'error' ? 'text-danger' : job.status === 'canceled' ? 'text-warning' : 'text-accent';
  const StatusIcon = job.status === 'success' ? CheckCircle2 : job.status === 'error' ? XCircle : job.status === 'canceled' ? CircleSlash : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="shrink-0 border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          {StatusIcon ? <StatusIcon size={16} className={tone} /> : <Spinner size={15} className="text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <span className="truncate">
                {job.kind === 'backup' ? 'Backup' : 'Restore'} · {job.kind === 'backup' ? job.database : `${job.file} → ${job.database}`}
              </span>
              <Badge tone="neutral">{FORMAT_LABEL[job.format]}</Badge>
            </div>
            <div className="truncate text-xs text-muted">{job.progressLabel ?? (running ? 'Starting…' : job.status)}</div>
          </div>
          {running ? (
            <Button variant="outline" size="sm" icon={<Square size={11} className="fill-current" />} onClick={() => void backupApi.cancel(job.id)}>
              Cancel
            </Button>
          ) : job.kind === 'backup' && job.status === 'success' ? (
            <>
              <Button size="sm" variant="ghost" icon={<ArchiveRestore size={14} />} onClick={() => onRestoreFile(job.file)}>
                Restore…
              </Button>
              <a href={backupApi.downloadUrl(job.file)} download>
                <Button size="sm" variant="primary" icon={<Download size={14} />}>Download</Button>
              </a>
            </>
          ) : null}
        </div>

        {/* progress */}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-active">
          {running && job.progress == null ? (
            <div className="h-full w-1/3 animate-[pg-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
          ) : (
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', job.status === 'error' ? 'bg-danger' : job.status === 'canceled' ? 'bg-warning' : job.status === 'success' ? 'bg-success' : 'bg-accent')}
              style={{ width: `${Math.round((job.status === 'success' ? 1 : job.progress ?? 0) * 100)}%` }}
            />
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
          <Stat icon={<Timer size={12} />} label="Elapsed" value={formatDuration(elapsed)} />
          <Stat icon={<HardDrive size={12} />} label={job.kind === 'backup' ? 'Output' : 'Input'} value={formatBytes(job.bytes)} />
          {job.progress != null && running && <Stat label="Progress" value={`${Math.round(job.progress * 100)}%`} />}
          <Stat icon={<FileArchive size={12} />} label="File" value={job.file} />
          {job.errors.length > 0 && <Stat icon={<AlertTriangle size={12} className="text-danger" />} label="Errors" value={String(job.errors.length)} />}
          {job.warnings > 0 && <Stat label="Warnings" value={String(job.warnings)} />}
        </div>
      </div>

      {/* summary */}
      {!running && job.summary && (
        <div
          className={cn(
            'mx-4 mt-3 shrink-0 rounded-lg border px-3 py-2.5 text-xs',
            job.status === 'success' ? 'border-success/30 bg-success-soft' : job.status === 'canceled' ? 'border-warning/30 bg-warning-soft' : 'border-danger/30 bg-danger-soft',
          )}
        >
          <div className={cn('font-medium', tone)}>{job.summary.message}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted">
            <span>Took {formatDuration(job.durationMs)}</span>
            {job.summary.tables != null && <span>{job.summary.tables} tables</span>}
            {job.summary.rows != null && <span>≈ {formatCount(job.summary.rows)} rows (planner estimate)</span>}
            {job.summary.sizeBytes != null && <span>{job.kind === 'restore' ? 'Database size' : 'Size'} {formatBytes(job.summary.sizeBytes)}</span>}
            {job.exitCode != null && <span>Exit code {job.exitCode}</span>}
          </div>
          {job.errors.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-auto font-mono text-[11px] text-danger">
              {job.errors.slice(0, 50).map((e, i) => (
                <li key={i} className="truncate" title={e}>{e}</li>
              ))}
              {job.errors.length > 50 && <li className="text-muted">… {job.errors.length - 50} more</li>}
            </ul>
          )}
        </div>
      )}

      {/* log console */}
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1.5">
        <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Log</span>
        <span className="text-[11px] text-subtle tabular-nums">{job.lineCount} lines</span>
        <div className="flex-1" />
        <button
          className={cn('rounded px-1.5 py-0.5 text-[11px]', filter === 'all' ? 'bg-active text-fg' : 'text-muted hover:text-fg')}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        <button
          className={cn('rounded px-1.5 py-0.5 text-[11px]', filter === 'errors' ? 'bg-active text-fg' : 'text-muted hover:text-fg')}
          onClick={() => setFilter('errors')}
        >
          Errors & warnings
        </button>
        <IconButton
          size="xs"
          label="Copy log"
          onClick={() => {
            void navigator.clipboard.writeText(lines.map((l) => l.text).join('\n'));
            toast.success('Log copied');
          }}
        >
          <Copy size={12} />
        </IconButton>
      </div>
      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-sunken px-3 py-2 font-mono text-[11.5px] leading-[1.6]"
      >
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-3 whitespace-pre-wrap break-all',
              l.level === 'error' ? 'text-danger' : l.level === 'warning' ? 'text-warning' : l.level === 'cmd' ? 'text-accent' : 'text-muted',
            )}
          >
            <span className="w-12 shrink-0 text-right text-subtle tabular-nums select-none">{(l.t / 1000).toFixed(1)}s</span>
            <span className="min-w-0 flex-1">{l.text}</span>
          </div>
        ))}
        {!shown.length && <div className="text-subtle">{filter === 'errors' ? 'No errors or warnings.' : 'Waiting for output…'}</div>}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {icon && <span className="text-subtle">{icon}</span>}
      <span className="text-subtle">{label}</span>
      <span className="max-w-[260px] truncate font-medium text-fg tabular-nums">{value}</span>
    </span>
  );
}
