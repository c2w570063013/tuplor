import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArchiveRestore, FileUp, UploadCloud } from 'lucide-react';
import type { BackupFile, RestoreOptions, ToolsInfo } from '@shared/backup';
import { Badge, Button, Field, Input, Segmented, Select, toast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { confirm } from '@/stores/dialogs';
import { useConnections } from '@/stores/connections';
import { backupApi, FORMAT_LABEL, isPlain } from './api';
import { Section, Toggle } from './BackupForm';

export function RestoreForm({
  connId, databases, files, file, onFile, tools, onStarted,
}: {
  connId: string;
  databases: string[];
  files: BackupFile[];
  file: string | null;
  onFile: (name: string | null) => void;
  tools: ToolsInfo | undefined;
  onStarted: (jobId: string) => void;
}) {
  const qc = useQueryClient();
  const selected = files.find((f) => f.name === file) ?? null;
  const plain = isPlain(selected?.format);
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [newDb, setNewDb] = useState('');
  const [existingDb, setExistingDb] = useState('');
  const [content, setContent] = useState<'both' | 'schema' | 'data'>('both');
  const [clean, setClean] = useState(false);
  const [noOwner, setNoOwner] = useState(true);
  const [noPrivileges, setNoPrivileges] = useState(false);
  const [singleTx, setSingleTx] = useState(false);
  const [exitOnError, setExitOnError] = useState(false);
  const [jobs, setJobs] = useState(4);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // suggest a target database name from the file
  useEffect(() => {
    if (!selected) return;
    const stem = (selected.database || selected.name.replace(/\.(sql\.gz|dir\.tar|sql|dump|tar|backup|gz)$/i, ''))
      .replace(/_\d{8}-\d{4,6}$/, '')
      .replace(/[^\w]+/g, '_')
      .toLowerCase();
    setNewDb(`${stem}_restored`);
  }, [selected?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const doUpload = async (f: File) => {
    setUpload({ name: f.name, progress: 0 });
    try {
      const saved = await backupApi.upload(f, (p) => setUpload({ name: f.name, progress: p }));
      await qc.invalidateQueries({ queryKey: ['backup-files'] });
      onFile(saved.name);
      toast.success(`Uploaded ${saved.name} (${FORMAT_LABEL[saved.format]})`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setUpload(null);
    }
  };

  const targetDb = target === 'new' ? newDb.trim() : existingDb;
  const binOk = tools && tools.status !== 'missing';
  const problem = !tools
    ? 'Checking client tools…'
    : !binOk
      ? tools.message
      : !selected
        ? 'Choose a backup file'
        : selected.format === 'unknown'
          ? 'Unrecognised file format'
          : !targetDb
            ? 'Choose a target database'
            : target === 'new' && databases.includes(targetDb)
              ? `Database "${targetDb}" already exists`
              : null;

  const parallelOk = !plain && selected?.format !== 'tar' && !singleTx;

  const start = async () => {
    if (!selected) return;
    if (target === 'existing') {
      const ok = await confirm({
        title: `Restore into "${targetDb}"?`,
        message: (
          <span>
            {selected.name} will be restored into the existing database <b>{targetDb}</b>.
            {clean && !plain ? ' Existing objects contained in the backup will be dropped first.' : ' Objects that already exist will produce errors.'} This cannot be undone.
          </span>
        ),
        danger: true,
        confirmLabel: 'Restore',
      });
      if (!ok) return;
    }
    const o: RestoreOptions = {
      file: selected.name,
      targetDb,
      createDb: target === 'new',
      clean: !plain && clean,
      noOwner: !plain && noOwner,
      noPrivileges: !plain && noPrivileges,
      dataOnly: !plain && content === 'data',
      schemaOnly: !plain && content === 'schema',
      singleTransaction: singleTx,
      exitOnError,
      jobs: parallelOk ? jobs : 1,
    };
    setBusy(true);
    try {
      const job = await backupApi.startRestore(connId, o);
      onStarted(job.id);
      if (target === 'new') void useConnections.getState().refresh(connId).catch(() => {});
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title="Backup file">
        <Select
          value={file ?? ''}
          onChange={(e) => onFile(e.target.value || null)}
          options={[
            { value: '', label: files.length ? 'Choose a backup…' : 'No backups yet — upload one below' },
            ...files.map((f) => ({ value: f.name, label: `${f.name}  ·  ${formatBytes(f.size)}` })),
          ]}
        />
        {selected && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={selected.format === 'unknown' ? 'danger' : 'accent'}>{FORMAT_LABEL[selected.format]}</Badge>
            <span>{formatBytes(selected.size)}</span>
            {selected.database && <span>from <b className="font-medium text-fg">{selected.database}</b></span>}
            <span>{new Date(selected.modifiedAt).toLocaleString()}</span>
            {selected.note && <span className="text-subtle">· {selected.note}</span>}
          </div>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) void doUpload(f);
          }}
          onClick={() => !upload && inputRef.current?.click()}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center transition-colors',
            drag ? 'border-accent bg-accent-soft' : 'border-border-strong hover:border-accent hover:bg-hover',
          )}
        >
          {upload ? (
            <>
              <div className="text-xs text-fg">Uploading {upload.name}…</div>
              <div className="mt-1 h-1 w-48 overflow-hidden rounded-full bg-active">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
              </div>
            </>
          ) : (
            <>
              <UploadCloud size={18} className="text-subtle" />
              <div className="text-xs text-fg">Drop a backup here or <span className="text-accent">browse</span></div>
              <div className="text-[11px] text-subtle">.dump · .backup · .tar · .sql · .sql.gz — format is detected automatically</div>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".dump,.backup,.tar,.sql,.gz,.pgdump"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void doUpload(f);
            }}
          />
        </div>
      </Section>

      <Section title="Target database">
        <Segmented
          value={target}
          onChange={setTarget}
          options={[
            { value: 'new', label: 'Create new database' },
            { value: 'existing', label: 'Existing database' },
          ]}
        />
        {target === 'new' ? (
          <Field label="New database name" hint="Created with TEMPLATE template0 before restoring">
            <Input value={newDb} onChange={(e) => setNewDb(e.target.value)} placeholder="my_database_restored" />
          </Field>
        ) : (
          <>
            <Field label="Database">
              <Select
                value={existingDb}
                onChange={(e) => setExistingDb(e.target.value)}
                options={[{ value: '', label: 'Choose…' }, ...databases.map((d) => ({ value: d, label: d }))]}
              />
            </Field>
            {existingDb && (
              <div className="flex items-start gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>Restoring into an existing database modifies it. Consider restoring into a new database first.</span>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Options">
        {plain ? (
          <p className="text-xs text-muted">
            SQL scripts are executed with <code className="font-mono">psql</code>; objects, ownership and clean-up are whatever the script contains.
          </p>
        ) : (
          <>
            <Segmented
              size="xs"
              value={content}
              onChange={setContent}
              options={[
                { value: 'both', label: 'Schema + data' },
                { value: 'schema', label: 'Schema only' },
                { value: 'data', label: 'Data only' },
              ]}
            />
            <div className="grid gap-0.5">
              <Toggle label="Clean (drop objects first)" hint="DROP … IF EXISTS before recreating" checked={clean} onChange={setClean} disabled={content === 'data'} />
              <Toggle label="No owner" hint="Objects are owned by the connecting user" checked={noOwner} onChange={setNoOwner} />
              <Toggle label="No privileges" hint="Skip GRANT / REVOKE" checked={noPrivileges} onChange={setNoPrivileges} />
            </div>
          </>
        )}
        <div className="grid gap-0.5">
          <Toggle label="Single transaction" hint="All or nothing (disables parallel restore)" checked={singleTx} onChange={setSingleTx} />
          <Toggle label="Stop on first error" hint="Otherwise errors are reported and skipped" checked={exitOnError} onChange={setExitOnError} />
        </div>
        {!plain && (
          <Field label="Parallel jobs" hint={parallelOk ? 'Data and indexes restored concurrently' : selected?.format === 'tar' ? 'Not supported for tar archives' : 'Not available with a single transaction'}>
            <Input
              size="sm"
              type="number"
              min={1}
              max={16}
              value={parallelOk ? jobs : 1}
              disabled={!parallelOk}
              onChange={(e) => setJobs(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </Field>
        )}
      </Section>

      <div className="sticky bottom-0 -mx-5 flex items-center gap-3 border-t border-border bg-panel px-5 py-3">
        <Button
          variant={target === 'existing' && targetDb ? 'danger' : 'primary'}
          size="md"
          icon={<ArchiveRestore size={14} />}
          onClick={start}
          loading={busy}
          disabled={!!problem}
        >
          Restore
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {problem ?? (
            <span className="inline-flex items-center gap-1.5">
              <FileUp size={12} /> {selected!.name} → {targetDb}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
