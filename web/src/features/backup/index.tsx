import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CheckCircle2, ChevronDown, CircleSlash, History, XCircle } from 'lucide-react';
import type { TabProps } from '../common/TabProps';
import { DropdownMenu, EmptyState, Segmented, Spinner, Toolbar } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { useConnections } from '@/stores/connections';
import { useWorkspace } from '@/stores/workspace';
import { backupApi } from './api';
import { BackupForm } from './BackupForm';
import { RestoreForm } from './RestoreForm';
import { JobPanel } from './JobPanel';
import { FilesList } from './FilesList';
import { ToolsStatus } from './ToolsStatus';

import './commands';

export default function BackupTab({ tab, active }: TabProps) {
  const connId = tab.connId;
  if (!connId || !tab.database) {
    return <EmptyState icon={<Archive size={28} />} title="No database selected" description="Open Backup & restore from a connected database." />;
  }
  return <BackupView tab={tab} active={active} />;
}

function BackupView({ tab, active }: TabProps) {
  const connId = tab.connId!;
  const set = (p: Record<string, any>) => useWorkspace.getState().updateParams(tab.id, p);
  const mode: 'backup' | 'restore' = tab.params.mode === 'restore' ? 'restore' : 'backup';
  const database: string = tab.params.backupDb ?? tab.database!;
  const jobId: string | null = tab.params.jobId ?? null;
  const restoreFile: string | null = tab.params.restoreFile ?? null;

  const info = useConnections((s) => s.state[connId]?.info);
  useEffect(() => {
    if (!info) void useConnections.getState().connect(connId).catch(() => {});
  }, [info, connId]);
  // database list changes underneath us (restores create databases, others drop them)
  useEffect(() => {
    if (active && mode === 'restore') void useConnections.getState().refresh(connId).catch(() => {});
  }, [active, mode, connId]);
  const runningCount = (jobsQ: { status: string }[] | undefined) => (jobsQ ?? []).filter((j) => j.status === 'running').length;
  const databases = useMemo(
    () => (info?.databases ?? []).filter((d) => !d.isTemplate && d.allowConn).map((d) => d.name),
    [info],
  );

  const tools = useQuery({ queryKey: ['backup-tools', connId], queryFn: () => backupApi.tools(connId), staleTime: 60_000 });
  const files = useQuery({ queryKey: ['backup-files'], queryFn: backupApi.files, refetchInterval: active ? 15_000 : false });
  const jobs = useQuery({ queryKey: ['backup-jobs'], queryFn: backupApi.jobs, refetchInterval: active ? 3_000 : false });

  const nRunning = runningCount(jobs.data);
  const prevRunning = useRef(nRunning);
  useEffect(() => {
    if (nRunning < prevRunning.current) void useConnections.getState().refresh(connId).catch(() => {});
    prevRunning.current = nRunning;
  }, [nRunning, connId]);
  const busyFiles = useMemo(() => new Set((jobs.data ?? []).filter((j) => j.status === 'running').map((j) => j.file)), [jobs.data]);

  const onStarted = (id: string) => {
    set({ jobId: id });
    void jobs.refetch();
  };
  const restoreFrom = (file: string) => set({ mode: 'restore', restoreFile: file });

  return (
    <div className="flex h-full flex-col">
      <Toolbar className="gap-2">
        <Segmented
          value={mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { value: 'backup', label: 'Backup', icon: <Archive size={13} /> },
            { value: 'restore', label: 'Restore', icon: <ArchiveRestore size={13} /> },
          ]}
        />
        <div className="flex-1" />
        <JobsMenu jobs={jobs.data ?? []} current={jobId} onPick={(id) => set({ jobId: id })} />
        <ToolsStatus tools={tools.data} loading={tools.isLoading} connId={connId} />
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        {/* form */}
        <div className="w-[440px] shrink-0 overflow-y-auto border-r border-border bg-panel px-5 pt-4">
          {mode === 'backup' ? (
            <BackupForm
              connId={connId}
              database={database}
              databases={databases.length ? databases : [database]}
              onDatabase={(db) => set({ backupDb: db })}
              tools={tools.data}
              onStarted={onStarted}
            />
          ) : (
            <RestoreForm
              connId={connId}
              databases={databases}
              files={files.data ?? []}
              file={restoreFile}
              onFile={(f) => set({ restoreFile: f })}
              tools={tools.data}
              onStarted={onStarted}
            />
          )}
        </div>

        {/* job + files */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-[3]">
            <JobPanel jobId={jobId} onRestoreFile={restoreFrom} />
          </div>
          <div className="min-h-[180px] flex-[2] border-t border-border">
            <FilesList
              files={files.data ?? []}
              loading={files.isLoading}
              fetching={files.isFetching}
              selected={mode === 'restore' ? restoreFile : null}
              onRestore={restoreFrom}
              busyFiles={busyFiles}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function JobsMenu({ jobs, current, onPick }: { jobs: import('@shared/backup').JobInfo[]; current: string | null; onPick: (id: string) => void }) {
  const running = jobs.filter((j) => j.status === 'running').length;
  if (!jobs.length) return null;
  return (
    <DropdownMenu
      align="end"
      trigger={
        <button className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg">
          {running ? <Spinner size={12} className="text-accent" /> : <History size={13} />}
          {running ? `${running} running` : 'Recent jobs'}
          <ChevronDown size={12} className="text-subtle" />
        </button>
      }
      items={[
        { heading: 'Jobs this session' },
        ...jobs.slice(0, 15).map((j) => ({
          label: (
            <span className={cn('flex items-center gap-2', j.id === current && 'font-medium')}>
              <span className="truncate">{j.kind === 'backup' ? `Backup ${j.database}` : `Restore → ${j.database}`}</span>
              <span className="ml-auto pl-3 text-[11px] opacity-60">{j.status === 'running' ? 'running' : formatDuration(j.durationMs)}</span>
            </span>
          ),
          icon:
            j.status === 'running' ? <Spinner size={12} /> : j.status === 'success' ? <CheckCircle2 size={13} className="text-success" /> : j.status === 'canceled' ? <CircleSlash size={13} className="text-warning" /> : <XCircle size={13} className="text-danger" />,
          onSelect: () => onPick(j.id),
        })),
      ]}
    />
  );
}
