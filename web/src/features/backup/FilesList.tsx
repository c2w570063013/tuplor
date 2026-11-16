import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, Download, FileArchive, FileCode2, FolderArchive, RefreshCw, Trash2 } from 'lucide-react';
import type { BackupFile } from '@shared/backup';
import { Badge, EmptyState, IconButton, Spinner, toast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { confirm } from '@/stores/dialogs';
import { backupApi, FORMAT_LABEL, isPlain } from './api';

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function FilesList({
  files, loading, fetching, selected, onRestore, busyFiles,
}: {
  files: BackupFile[];
  loading: boolean;
  fetching: boolean;
  selected: string | null;
  onRestore: (name: string) => void;
  busyFiles: Set<string>;
}) {
  const qc = useQueryClient();
  const total = files.reduce((n, f) => n + f.size, 0);

  const remove = async (f: BackupFile) => {
    const ok = await confirm({
      title: `Delete ${f.name}?`,
      message: `The backup file (${formatBytes(f.size)}) is permanently removed from ~/.pgstudio/backups. This cannot be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await backupApi.deleteFile(f.name);
      toast.success(`Deleted ${f.name}`);
      void qc.invalidateQueries({ queryKey: ['backup-files'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-[11px] font-semibold tracking-wide text-subtle uppercase">Backups</span>
        <span className="text-[11px] text-subtle tabular-nums">
          {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(total)}
        </span>
        <div className="flex-1" />
        <span className="hidden truncate font-mono text-[10.5px] text-subtle md:inline">~/.pgstudio/backups</span>
        <IconButton size="sm" label="Refresh" onClick={() => void qc.invalidateQueries({ queryKey: ['backup-files'] })}>
          <RefreshCw size={13} className={cn(fetching && 'animate-spin')} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted"><Spinner size={12} /> Loading…</div>
        ) : !files.length ? (
          <EmptyState icon={<FolderArchive size={24} />} title="No backups yet" description="Backups you create or upload are listed here." />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] text-subtle">
              <tr>
                <th className="px-4 py-1.5 font-medium">Name</th>
                <th className="w-[84px] px-2 py-1.5 font-medium">Format</th>
                <th className="w-[22%] px-2 py-1.5 font-medium">Database</th>
                <th className="w-[72px] px-2 py-1.5 text-right font-medium">Size</th>
                <th className="w-[92px] px-2 py-1.5 font-medium">Created</th>
                <th className="w-[104px] px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const Icon = isPlain(f.format) ? FileCode2 : FileArchive;
                const busy = busyFiles.has(f.name);
                return (
                  <tr
                    key={f.name}
                    className={cn('group border-t border-border hover:bg-hover', selected === f.name && 'bg-accent-soft hover:bg-accent-soft')}
                    onDoubleClick={() => onRestore(f.name)}
                  >
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <Icon size={14} className="shrink-0 text-subtle" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-fg" title={f.name}>{f.name}</div>
                          {f.note && <div className="truncate text-[11px] text-subtle">{f.note}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1.5"><Badge tone={f.format === 'unknown' ? 'danger' : 'neutral'}>{FORMAT_LABEL[f.format]}</Badge></td>
                    <td className="truncate px-2 py-1.5 text-muted">{f.database ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right text-muted tabular-nums">{formatBytes(f.size)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted" title={new Date(f.modifiedAt).toLocaleString()}>{ago(f.modifiedAt)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                        <IconButton size="sm" label="Restore…" onClick={() => onRestore(f.name)} disabled={busy}>
                          <ArchiveRestore size={14} />
                        </IconButton>
                        <a href={backupApi.downloadUrl(f.name)} download tabIndex={-1}>
                          <IconButton size="sm" label="Download">
                            <Download size={14} />
                          </IconButton>
                        </a>
                        <IconButton size="sm" label="Delete" onClick={() => void remove(f)} disabled={busy} className="hover:text-danger">
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
