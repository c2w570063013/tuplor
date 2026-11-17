import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Play } from 'lucide-react';
import type { BackupFormat, BackupOptions, ToolsInfo } from '@shared/backup';
import { Button, Field, Input, Segmented, Select, Spinner, Switch, toast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { backupApi } from './api';
import { ObjectTree } from './ObjectTree';

const FORMATS: { value: BackupFormat; label: string; ext: string; help: string }[] = [
  { value: 'custom', label: 'Custom', ext: '.dump', help: 'Compressed archive for pg_restore. Most flexible: pick objects, reorder, restore in parallel.' },
  { value: 'plain', label: 'SQL', ext: '.sql', help: 'Plain SQL script, readable and restorable with psql anywhere.' },
  { value: 'directory', label: 'Directory', ext: '.dir.tar', help: 'One file per table, dumped in parallel; packed into a .tar for download.' },
  { value: 'tar', label: 'Tar', ext: '.tar', help: 'Uncompressed tar archive for pg_restore.' },
];

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function BackupForm({
  connId, database, databases, onDatabase, tools, onStarted,
}: {
  connId: string;
  database: string;
  databases: string[];
  onDatabase: (db: string) => void;
  tools: ToolsInfo | undefined;
  onStarted: (jobId: string) => void;
}) {
  const tree = useQuery({ queryKey: ['backup-tree', connId, database], queryFn: () => backupApi.tree(connId, database), staleTime: 30_000 });

  const [format, setFormat] = useState<BackupFormat>('custom');
  const [scope, setScope] = useState<BackupOptions['scope']>('database');
  const [schemas, setSchemas] = useState<Set<string>>(new Set());
  const [tables, setTables] = useState<Set<string>>(new Set());
  const [noData, setNoData] = useState<Set<string>>(new Set());
  const [content, setContent] = useState<'both' | 'schema' | 'data'>('both');
  const [noOwner, setNoOwner] = useState(false);
  const [noPrivileges, setNoPrivileges] = useState(false);
  const [clean, setClean] = useState(false);
  const [create, setCreate] = useState(false);
  const [dataAs, setDataAs] = useState<BackupOptions['dataAs']>('copy');
  const [compression, setCompression] = useState<string>('default');
  const [jobs, setJobs] = useState(4);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);

  // reset selection when the database changes
  useEffect(() => {
    setSchemas(new Set());
    setTables(new Set());
    setNoData(new Set());
    setFileName('');
  }, [database]);

  const fmt = FORMATS.find((f) => f.value === format)!;
  const defaultName = `${database}_${stamp()}`;
  const ext = format === 'plain' && compression !== 'default' && compression !== '0' ? '.sql.gz' : fmt.ext;

  const problem = useMemo(() => {
    if (!tools) return 'Checking client tools…';
    if (tools.status === 'missing' || tools.status === 'older') return tools.message;
    if (scope === 'schemas' && !schemas.size) return 'Select at least one schema';
    if (scope === 'tables' && !tables.size) return 'Select at least one table';
    return null;
  }, [tools, scope, schemas, tables]);

  const start = async () => {
    const o: BackupOptions = {
      format,
      scope,
      schemas: [...schemas],
      tables: [...tables],
      excludeTableData: [...noData],
      schemaOnly: content === 'schema',
      dataOnly: content === 'data',
      noOwner,
      noPrivileges,
      clean: format === 'plain' && clean,
      create: format === 'plain' && create,
      dataAs,
      compression: compression === 'default' ? null : Number(compression),
      jobs: format === 'directory' ? jobs : 1,
      fileName: fileName.trim() || defaultName,
    };
    setBusy(true);
    try {
      const job = await backupApi.startBackup(connId, database, o);
      onStarted(job.id);
      setFileName('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title="Source">
        <Field label="Database">
          <Select value={database} onChange={(e) => onDatabase(e.target.value)} options={databases.map((d) => ({ value: d, label: d }))} />
        </Field>
      </Section>

      <Section title="Format">
        <Segmented value={format} onChange={setFormat} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} />
        <p className="text-xs text-muted">{fmt.help}</p>
      </Section>

      <Section title="What to back up">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'database', label: 'Whole database' },
            { value: 'schemas', label: 'Schemas' },
            { value: 'tables', label: 'Tables' },
          ]}
        />
        {tree.isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted"><Spinner size={12} /> Loading objects…</div>
        ) : tree.error ? (
          <div className="text-xs text-danger">{(tree.error as Error).message}</div>
        ) : (
          <ObjectTree
            tree={tree.data ?? []}
            mode={scope}
            schemas={schemas}
            tables={tables}
            noData={noData}
            onSchemas={setSchemas}
            onTables={setTables}
            onNoData={setNoData}
          />
        )}
        <p className="text-[11px] text-subtle">
          {scope === 'database' && 'Everything in the database. '}
          {scope === 'schemas' && `${schemas.size} schema${schemas.size === 1 ? '' : 's'} selected. `}
          {scope === 'tables' && `${tables.size} table${tables.size === 1 ? '' : 's'} selected (dependent objects like sequences owned by them are included). `}
          {noData.size > 0 && `${noData.size} table${noData.size === 1 ? '' : 's'} without data. `}
          Hover a table and click the data icon to back up its structure only.
        </p>
      </Section>

      <Section title="Options">
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
          <Toggle label="No owner" hint="Skip ALTER … OWNER TO (restore as any user)" checked={noOwner} onChange={setNoOwner} />
          <Toggle label="No privileges" hint="Skip GRANT / REVOKE" checked={noPrivileges} onChange={setNoPrivileges} />
          <Toggle
            label="Clean (DROP … IF EXISTS)"
            hint={format === 'plain' ? 'Drop objects before recreating them' : 'Archive formats choose this at restore time'}
            checked={format === 'plain' && clean}
            onChange={setClean}
            disabled={format !== 'plain' || content === 'data'}
          />
          <Toggle
            label="Include CREATE DATABASE"
            hint={format === 'plain' ? 'Script creates and connects to the database' : 'Only for SQL format'}
            checked={format === 'plain' && create}
            onChange={setCreate}
            disabled={format !== 'plain'}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Data as">
            <Select
              size="sm"
              value={dataAs}
              onChange={(e) => setDataAs(e.target.value as BackupOptions['dataAs'])}
              disabled={content === 'schema'}
              options={[
                { value: 'copy', label: 'COPY (fastest)' },
                { value: 'inserts', label: 'INSERT statements' },
                { value: 'column-inserts', label: 'INSERT with column names' },
              ]}
            />
          </Field>
          <Field label="Compression">
            <Select
              size="sm"
              value={format === 'tar' ? '0' : compression}
              disabled={format === 'tar'}
              onChange={(e) => setCompression(e.target.value)}
              options={[
                { value: 'default', label: format === 'plain' ? 'None (default)' : 'Default' },
                { value: '0', label: '0 — none' },
                ...[1, 3, 5, 6, 9].map((n) => ({ value: String(n), label: `${n}${n === 1 ? ' — fastest' : n === 9 ? ' — smallest' : ''}` })),
              ]}
            />
          </Field>
          {format === 'directory' && (
            <Field label="Parallel jobs" hint="Tables dumped concurrently">
              <Input size="sm" type="number" min={1} max={16} value={jobs} onChange={(e) => setJobs(Math.max(1, Math.min(16, Number(e.target.value) || 1)))} />
            </Field>
          )}
        </div>
      </Section>

      <Section title="Output">
        <Field label="File name" hint="Saved to ~/.tuplor/backups/">
          <div className="flex items-center">
            <Input value={fileName} placeholder={defaultName} onChange={(e) => setFileName(e.target.value)} className="rounded-r-none" />
            <span className="flex h-8 items-center rounded-r-md border border-l-0 border-border-strong bg-sunken px-2 font-mono text-xs text-muted">{ext}</span>
          </div>
        </Field>
      </Section>

      <div className="sticky bottom-0 -mx-5 flex items-center gap-3 border-t border-border bg-panel px-5 py-3">
        <Button variant="primary" size="md" icon={<Play size={13} className="fill-current" />} onClick={start} loading={busy} disabled={!!problem}>
          Start backup
        </Button>
        <span className={cn('min-w-0 flex-1 text-xs', problem ? 'text-muted' : 'text-subtle')}>
          {problem ?? (
            <span className="inline-flex items-center gap-1.5">
              <Archive size={12} /> {database}{fmt.ext && ` → ${(fileName.trim() || defaultName) + ext}`}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 hover:bg-hover', disabled && 'cursor-default opacity-50 hover:bg-transparent')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{label}</div>
        {hint && <div className="text-[11px] text-subtle">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}
