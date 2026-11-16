import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Info, Wrench, XCircle } from 'lucide-react';
import type { ToolsInfo } from '@shared/backup';
import { Badge, Button, Dialog, Field, Input, Spinner, toast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { backupApi } from './api';

const STATUS = {
  ok: { icon: CheckCircle2, tone: 'text-success' },
  newer: { icon: Info, tone: 'text-info' },
  older: { icon: AlertTriangle, tone: 'text-danger' },
  missing: { icon: XCircle, tone: 'text-danger' },
};

/** Toolbar chip: client tools version vs server, opens the configuration dialog. */
export function ToolsStatus({ tools, loading, connId }: { tools: ToolsInfo | undefined; loading: boolean; connId: string }) {
  const [open, setOpen] = useState(false);
  if (loading || !tools) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 text-xs text-muted">
        <Spinner size={12} /> Detecting pg_dump…
      </span>
    );
  }
  const s = STATUS[tools.status];
  const Icon = s.icon;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg"
        title={tools.message ?? 'Client tools match the server'}
      >
        <Icon size={13} className={s.tone} />
        {tools.binaries.pg_dump.version ? (
          <span>
            pg_dump <span className="font-medium text-fg">{tools.binaries.pg_dump.version}</span>
            {tools.serverVersion && (
              <>
                {' '}· server <span className="font-medium text-fg">{tools.serverVersion}</span>
              </>
            )}
          </span>
        ) : (
          <span className="text-danger">Client tools not found</span>
        )}
        <Wrench size={12} className="text-subtle" />
      </button>
      <ToolsDialog open={open} onOpenChange={setOpen} tools={tools} connId={connId} />
    </>
  );
}

function ToolsDialog({ open, onOpenChange, tools, connId }: { open: boolean; onOpenChange: (o: boolean) => void; tools: ToolsInfo; connId: string }) {
  const qc = useQueryClient();
  const [dir, setDir] = useState(tools.customBinDir ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (binDir: string | null) => {
    setBusy(true);
    try {
      await backupApi.setBinDir(binDir);
      await qc.invalidateQueries({ queryKey: ['backup-tools'] });
      toast.success(binDir ? `Using client tools from ${binDir}` : 'Using auto-detected client tools');
      setDir(binDir ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const rescan = async () => {
    setBusy(true);
    try {
      const fresh = await backupApi.tools(connId, true);
      qc.setQueryData(['backup-tools', connId], fresh);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="PostgreSQL client tools"
      description="Backups run pg_dump, restores run pg_restore or psql. Their major version should be ≥ the server's."
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={rescan} loading={busy}>Rescan</Button>
          <div className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {tools.message && (
          <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs', tools.status === 'newer' ? 'bg-accent-soft text-fg' : 'bg-danger-soft text-danger')}>
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>{tools.message}</span>
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-xs">
            <tbody>
              {Object.values(tools.binaries).map((b) => (
                <tr key={b.name} className="border-b border-border last:border-0">
                  <td className="w-24 px-3 py-2 font-mono font-medium">{b.name}</td>
                  <td className="px-2 py-2">
                    {b.version ? <Badge tone={tools.serverMajor && b.major! < tools.serverMajor ? 'danger' : 'success'}>{b.version}</Badge> : <Badge tone="danger">missing</Badge>}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-muted" title={b.path ?? ''}>{b.path ?? '—'}</td>
                </tr>
              ))}
              <tr className="bg-sunken">
                <td className="px-3 py-2 font-medium">server</td>
                <td className="px-2 py-2">{tools.serverVersion ? <Badge>{tools.serverVersion}</Badge> : '—'}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Detected installations</div>
          <div className="flex flex-col gap-1">
            {tools.candidates.map((c) => {
              const active = c.dir === tools.binDir;
              return (
                <div key={c.dir} className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs', active ? 'border-accent bg-accent-soft' : 'border-border')}>
                  <Badge tone={tools.serverMajor && c.major < tools.serverMajor ? 'danger' : 'neutral'}>{c.version}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono" title={c.dir}>{c.dir}</span>
                  <span className="text-subtle">{c.source}</span>
                  {active ? (
                    <span className="px-2 text-[11px] font-medium text-accent">In use</span>
                  ) : (
                    <Button size="xs" variant="outline" onClick={() => void save(c.dir)} disabled={busy}>Use</Button>
                  )}
                </div>
              );
            })}
            {!tools.candidates.length && <div className="text-xs text-muted">No pg_dump found on this machine.</div>}
          </div>
        </div>

        <Field label="Custom bin directory" hint="Folder containing pg_dump, pg_restore and psql. Saved in ~/.pgstudio.">
          <div className="flex gap-2">
            <Input mono value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/opt/homebrew/opt/postgresql@18/bin" />
            <Button onClick={() => void save(dir.trim() || null)} disabled={busy || !dir.trim()}>Save</Button>
            {tools.customBinDir && <Button variant="ghost" onClick={() => void save(null)} disabled={busy}>Auto-detect</Button>}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
