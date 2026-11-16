import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, CheckCircle2, FileSpreadsheet, KeyRound, Table2, Upload, Wand2, X,
} from 'lucide-react';
import Papa from 'papaparse';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableColumn } from '@shared/tableData';
import { DataGrid, formatByteSize, type GridColumn } from '@/components/grid';
import {
  Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Select, Spinner, Switch, Toolbar, toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import { invalidateDb, queryClient } from '@/lib/queryClient';
import { confirm } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import type { TabProps } from '../common/TabProps';
import { shortType, tableApi } from './api';
import './commands';

const DELIMITERS = [
  { value: '', label: 'Auto-detect' },
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab  ⇥' },
  { value: '|', label: 'Pipe  |' },
];
const ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'windows-1252', label: 'Windows-1252 (Latin)' },
  { value: 'big5', label: 'Big5 (繁體中文)' },
  { value: 'gbk', label: 'GBK (简体中文)' },
  { value: 'shift_jis', label: 'Shift_JIS (日本語)' },
];
const SKIP = '-1';
const BATCH_ROWS = 2000;

interface Options {
  header: boolean;
  delimiter: string;
  encoding: string;
  emptyAsNull: boolean;
  nullString: string;
  truncate: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; rows: number; bytes: number; startedAt: number }
  | { kind: 'done'; rows: number; ms: number }
  | { kind: 'error'; message: string; detail?: string; hint?: string; rowNumber?: number; row?: (string | null)[]; rows: number }
  | { kind: 'cancelled'; rows: number };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export default function ImportTab({ tab }: TabProps) {
  const connId = tab.connId!;
  const db = tab.database!;
  const schema: string | undefined = tab.params.schema;
  const table: string | undefined = tab.params.table;
  const setTarget = (s?: string, t?: string) => {
    useWorkspace.getState().updateParams(tab.id, { schema: s, table: t });
    useWorkspace.getState().updateTab(tab.id, { title: t ? `Import · ${t}` : 'Import CSV' });
  };

  // ---------------------------------------------------------------- target
  const schemasQ = useQuery({ queryKey: ['schemas', connId, db], queryFn: () => api.schemas(connId, db) });
  const objectsQ = useQuery({ queryKey: ['objects', connId, db, schema], queryFn: () => api.objects(connId, db, schema!), enabled: !!schema });
  const tables = (objectsQ.data ?? []).filter((o) => o.kind === 'table' || o.kind === 'partitioned_table' || o.kind === 'view' || o.kind === 'foreign_table');
  const infoQ = useQuery({
    queryKey: ['table-info', connId, db, schema, table],
    queryFn: () => tableApi.info(connId, db, schema!, table!),
    enabled: !!schema && !!table,
  });
  const info = infoQ.data;
  const targetCols = useMemo(() => info?.columns ?? [], [info]);

  // ---------------------------------------------------------------- file & options
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState<Options>({ header: true, delimiter: '', encoding: 'utf-8', emptyAsNull: true, nullString: '', truncate: false });
  const [preview, setPreview] = useState<{ rows: string[][]; delimiter: string; error?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    let cancelled = false;
    Papa.parse<string[]>(file, {
      preview: 101,
      delimiter: opts.delimiter,
      encoding: opts.encoding,
      skipEmptyLines: 'greedy',
      complete: (r) => {
        if (cancelled) return;
        const err = r.errors.find((e) => e.type !== 'Delimiter');
        setPreview({ rows: r.data, delimiter: r.meta.delimiter, error: err ? `Row ${(err.row ?? 0) + 1}: ${err.message}` : undefined });
      },
      error: (e) => { if (!cancelled) setPreview({ rows: [], delimiter: '', error: e.message }); },
    });
    return () => { cancelled = true; };
  }, [file, opts.delimiter, opts.encoding]);

  const csvHeaders = useMemo(() => {
    const first = preview?.rows[0] ?? [];
    return first.map((h, i) => (opts.header ? (h.trim() || `column ${i + 1}`) : `column ${i + 1}`));
  }, [preview, opts.header]);
  const sampleRows = useMemo(() => (preview ? (opts.header ? preview.rows.slice(1) : preview.rows).slice(0, 100) : []), [preview, opts.header]);

  // ---------------------------------------------------------------- mapping: table column index -> csv column index
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const autoMap = () => {
    const m: Record<string, number> = {};
    const used = new Set<number>();
    for (const c of targetCols) {
      if (!c.updatable) continue;
      let idx = opts.header ? csvHeaders.findIndex((h, i) => !used.has(i) && norm(h) === norm(c.name)) : -1;
      if (idx < 0 && !opts.header && !c.identity && !(c.isPrimaryKey && c.default)) {
        // positional mapping when there is no header row: skip auto-generated keys
        const writable = targetCols.filter((x) => x.updatable && !x.identity && !(x.isPrimaryKey && x.default));
        const pos = writable.indexOf(c);
        if (pos >= 0 && pos < csvHeaders.length) idx = pos;
      }
      if (idx >= 0) { m[c.name] = idx; used.add(idx); }
    }
    setMapping(m);
  };
  const mapKey = `${csvHeaders.join('\u0001')}|${targetCols.map((c) => c.name).join(',')}|${opts.header}`;
  useEffect(() => { autoMap(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mapKey]);
  const mapped = targetCols.filter((c) => mapping[c.name] !== undefined && mapping[c.name] >= 0);
  const missingRequired = targetCols.filter((c) => c.updatable && !c.nullable && c.default == null && !c.identity && mapping[c.name] === undefined);

  // ---------------------------------------------------------------- import
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const cancelRef = useRef(false);
  const running = phase.kind === 'running';

  const toValue = (v: string | undefined): string | null => {
    if (v === undefined) return null;
    if (opts.nullString !== '' && v === opts.nullString) return null;
    if (opts.emptyAsNull && v === '') return null;
    return v;
  };

  const runImport = async () => {
    if (!file || !info || !schema || !table || !mapped.length) return;
    if (opts.truncate && !(await confirm({
      title: `Truncate ${schema}.${table}?`,
      message: 'All existing rows are deleted before the import. Everything runs in one transaction: if the import fails, the truncate is rolled back too.',
      danger: true,
      confirmLabel: 'Truncate & import',
    }))) return;

    cancelRef.current = false;
    const startedAt = performance.now();
    setPhase({ kind: 'running', rows: 0, bytes: 0, startedAt });
    const colIdx = mapped.map((c) => mapping[c.name]);
    let importId: string;
    try {
      importId = (await tableApi.importBegin(connId, db, schema, table, { columns: mapped.map((c) => c.name), truncate: opts.truncate })).importId;
    } catch (e) {
      const info = e instanceof ApiError ? e.info : { message: String(e) };
      setPhase({ kind: 'error', message: info.message, detail: info.detail, hint: info.hint, rows: 0 });
      return;
    }

    let total = 0;
    let sourceRow = 0; // 1-based line number in the file (header counts as row 1)
    let headerSkipped = !opts.header;
    let failed: Phase | null = null;
    let batch: (string | null)[][] = [];
    let batchFirst = 0;

    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      const first = batchFirst;
      batch = [];
      const r = await tableApi.importBatch(connId, db, schema, table, importId, { rows, firstRowNumber: first });
      total = r.total;
    };

    await new Promise<void>((resolve) => {
      Papa.parse<string[]>(file, {
        delimiter: opts.delimiter || preview?.delimiter || '',
        encoding: opts.encoding,
        skipEmptyLines: 'greedy',
        chunkSize: 1024 * 512,
        chunk: (res, parser) => {
          parser.pause();
          void (async () => {
            try {
              for (const line of res.data) {
                sourceRow++;
                if (!headerSkipped) { headerSkipped = true; continue; }
                if (!batch.length) batchFirst = sourceRow;
                batch.push(colIdx.map((i) => toValue(line[i])));
                if (batch.length >= BATCH_ROWS) await flush();
              }
              setPhase({ kind: 'running', rows: total, bytes: res.meta.cursor, startedAt });
              if (cancelRef.current) { parser.abort(); return; }
              parser.resume();
            } catch (e) {
              const info = (e instanceof ApiError ? e.info : { message: String(e) }) as ApiError['info'] & { rowNumber?: number; row?: (string | null)[] };
              failed = { kind: 'error', message: info.message, detail: info.detail, hint: info.hint, rowNumber: info.rowNumber, row: info.row, rows: total };
              parser.abort();
            }
          })();
        },
        complete: () => resolve(),
        error: (e) => { failed = { kind: 'error', message: `Could not read the file: ${e.message}`, rows: total }; resolve(); },
      });
    });

    try {
      if (!failed && !cancelRef.current) await flush();
    } catch (e) {
      const info = (e instanceof ApiError ? e.info : { message: String(e) }) as ApiError['info'] & { rowNumber?: number; row?: (string | null)[] };
      failed = { kind: 'error', message: info.message, detail: info.detail, hint: info.hint, rowNumber: info.rowNumber, row: info.row, rows: total };
    }

    if (failed || cancelRef.current) {
      await tableApi.importRollback(connId, db, schema, table, importId).catch(() => {});
      setPhase(failed ?? { kind: 'cancelled', rows: total });
      return;
    }
    try {
      const r = await tableApi.importCommit(connId, db, schema, table, importId);
      const ms = performance.now() - startedAt;
      setPhase({ kind: 'done', rows: r.total, ms });
      toast.success(`Imported ${r.total.toLocaleString()} rows into ${schema}.${table}`, { description: formatDuration(ms) });
      invalidateDb(connId, db);
      void queryClient.invalidateQueries({ queryKey: ['table-rows', connId, db, schema, table] });
      void queryClient.invalidateQueries({ queryKey: ['table-count', connId, db, schema, table] });
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message, rows: total });
    }
  };

  const openTable = () => useWorkspace.getState().openTab({
    kind: 'table-data', title: table!, connId, database: db, key: `data:${connId}:${db}:${schema}.${table}`, params: { schema, table },
  });

  // ---------------------------------------------------------------- render
  const previewColumns: GridColumn[] = csvHeaders.map((h) => ({ name: h, typeName: 'text' }));
  const progress = running && file ? Math.min(1, phase.bytes / file.size) : 0;
  const elapsed = running ? (performance.now() - phase.startedAt) / 1000 : 0;

  return (
    <div className="flex h-full flex-col">
      <Toolbar className="gap-2">
        <FileSpreadsheet size={15} className="text-accent" />
        <span className="text-[13px] font-medium">Import CSV into</span>
        <Select
          size="sm"
          className="w-40"
          value={schema ?? ''}
          onChange={(e) => setTarget(e.target.value || undefined, undefined)}
          options={[{ value: '', label: 'Schema…' }, ...(schemasQ.data ?? []).map((s) => ({ value: s.name, label: s.name }))]}
          disabled={running}
        />
        <span className="text-subtle">.</span>
        <Select
          size="sm"
          className="w-52"
          value={table ?? ''}
          onChange={(e) => setTarget(schema, e.target.value || undefined)}
          options={[{ value: '', label: schema ? 'Table…' : '—' }, ...tables.map((t) => ({ value: t.name, label: t.name }))]}
          disabled={!schema || running}
        />
        {info && !info.canInsert && <Badge tone="danger">read-only</Badge>}
        <div className="flex-1" />
        {schema && table && <Button size="sm" variant="ghost" icon={<Table2 size={13} />} onClick={openTable}>Open table</Button>}
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
          {/* file picker */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) { setFile(f); setPhase({ kind: 'idle' }); }
            }}
            className={cn(
              'flex items-center gap-4 rounded-xl border border-dashed p-4 transition-colors',
              dragOver ? 'border-accent bg-accent-soft' : 'border-border-strong bg-panel',
            )}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Upload size={20} /></div>
            {file ? (
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-fg">{file.name}</div>
                <div className="text-xs text-muted">
                  {formatByteSize(file.size)}
                  {preview?.delimiter && <> · delimiter <code className="rounded bg-active px-1">{preview.delimiter === '\t' ? '⇥ tab' : preview.delimiter}</code></>}
                  {csvHeaders.length > 0 && <> · {csvHeaders.length} columns</>}
                </div>
              </div>
            ) : (
              <div className="flex-1">
                <div className="text-[13px] font-medium text-fg">Drop a CSV / TSV file here</div>
                <div className="text-xs text-muted">or choose one from your computer · parsed locally, streamed to the server in batches</div>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setPhase({ kind: 'idle' }); } e.target.value = ''; }}
            />
            <Button variant={file ? 'outline' : 'primary'} onClick={() => inputRef.current?.click()} disabled={running}>{file ? 'Choose another…' : 'Choose file…'}</Button>
            {file && !running && <IconButton label="Remove file" onClick={() => setFile(null)}><X size={14} /></IconButton>}
          </div>

          {/* options */}
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl border border-border bg-panel p-4 md:grid-cols-4">
            <Field label="Delimiter">
              <Select size="sm" value={opts.delimiter} onChange={(e) => setOpts({ ...opts, delimiter: e.target.value })} options={DELIMITERS} disabled={running} />
            </Field>
            <Field label="Encoding">
              <Select size="sm" value={opts.encoding} onChange={(e) => setOpts({ ...opts, encoding: e.target.value })} options={ENCODINGS} disabled={running} />
            </Field>
            <Field label="NULL string" hint="Cells equal to this become NULL (e.g. \N or NULL)">
              <Input size="sm" mono value={opts.nullString} placeholder="(none)" onChange={(e) => setOpts({ ...opts, nullString: e.target.value })} disabled={running} />
            </Field>
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-fg"><Switch checked={opts.header} onCheckedChange={(v) => setOpts({ ...opts, header: v })} disabled={running} /> First row is a header</label>
              <label className="flex items-center gap-2 text-xs text-fg"><Checkbox checked={opts.emptyAsNull} onCheckedChange={(v) => setOpts({ ...opts, emptyAsNull: v })} disabled={running} /> Empty cells → NULL</label>
              <label className={cn('flex items-center gap-2 text-xs', opts.truncate ? 'text-danger' : 'text-fg')}>
                <Checkbox checked={opts.truncate} onCheckedChange={(v) => setOpts({ ...opts, truncate: v })} disabled={running} /> Truncate table first
              </label>
            </div>
          </div>

          {!schema || !table ? (
            <EmptyState className="h-auto rounded-xl border border-border py-10" icon={<Table2 size={26} />} title="Choose a target table" description="Pick the schema and table to import into using the selectors above." />
          ) : infoQ.isLoading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : infoQ.error ? (
            <div className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-xs text-danger">{(infoQ.error as Error).message}</div>
          ) : info && !info.canInsert ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-xs text-fg">
              <AlertCircle size={14} className="mt-px shrink-0 text-warning" /> Rows can't be inserted into {schema}.{table}. {info.readOnlyReason}
            </div>
          ) : !file ? null : preview?.error && !preview.rows.length ? (
            <div className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-xs text-danger">{preview.error}</div>
          ) : (
            <>
              {/* mapping */}
              <section className="rounded-xl border border-border">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <span className="text-[13px] font-semibold">Column mapping</span>
                  <span className="text-xs text-subtle">{mapped.length} of {targetCols.filter((c) => c.updatable).length} table columns mapped</span>
                  <div className="flex-1" />
                  <Button size="xs" variant="ghost" icon={<Wand2 size={12} />} onClick={autoMap} disabled={running}>Auto-match</Button>
                  <Button size="xs" variant="ghost" onClick={() => setMapping({})} disabled={running}>Clear</Button>
                </div>
                <div className="max-h-[320px] overflow-auto">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 bg-grid-header text-left text-[11px] text-subtle">
                      <tr>
                        <th className="px-4 py-1.5 font-medium">Table column</th>
                        <th className="w-6" />
                        <th className="px-2 py-1.5 font-medium">CSV column</th>
                        <th className="px-2 py-1.5 font-medium">Sample</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targetCols.map((c) => (
                        <MappingRow
                          key={c.name}
                          col={c}
                          value={mapping[c.name]}
                          headers={csvHeaders}
                          sample={mapping[c.name] !== undefined ? sampleRows[0]?.[mapping[c.name]] : undefined}
                          disabled={running}
                          onChange={(idx) => setMapping((m) => {
                            const n = { ...m };
                            if (idx < 0) delete n[c.name]; else n[c.name] = idx;
                            return n;
                          })}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* preview */}
              <section className="flex flex-col overflow-hidden rounded-xl border border-border">
                <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                  <span className="text-[13px] font-semibold">Preview</span>
                  <span className="text-xs text-subtle">first {sampleRows.length} rows</span>
                  {preview?.error && <span className="ml-2 flex items-center gap-1 text-xs text-warning"><AlertCircle size={12} /> {preview.error}</span>}
                </div>
                <div className="h-[240px]">
                  <DataGrid columns={previewColumns} rows={sampleRows} emptyMessage="No data rows" />
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {/* footer: status & action */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-panel px-4 py-2.5">
        {phase.kind === 'running' ? (
          <>
            <Spinner className="text-accent" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex justify-between text-xs">
                <span className="text-fg">Importing… <b className="tabular-nums">{phase.rows.toLocaleString()}</b> rows</span>
                <span className="text-subtle tabular-nums">{Math.round(progress * 100)}% · {elapsed > 0.5 ? `${Math.round(phase.rows / elapsed).toLocaleString()} rows/s` : ''}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-active">
                <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(2, progress * 100)}%` }} />
              </div>
            </div>
            <Button variant="outline" onClick={() => { cancelRef.current = true; }}>Cancel</Button>
          </>
        ) : phase.kind === 'done' ? (
          <>
            <CheckCircle2 size={16} className="text-success" />
            <span className="flex-1 text-[13px]">Imported <b>{phase.rows.toLocaleString()}</b> rows into {schema}.{table} in {formatDuration(phase.ms)} — committed.</span>
            <Button variant="ghost" icon={<ArrowLeft size={13} />} onClick={() => setPhase({ kind: 'idle' })}>Import more</Button>
            <Button variant="primary" icon={<Table2 size={13} />} onClick={openTable}>Open table</Button>
          </>
        ) : phase.kind === 'error' ? (
          <>
            <AlertCircle size={16} className="shrink-0 text-danger" />
            <div className="min-w-0 flex-1 text-xs">
              <div className="font-medium text-danger">
                {phase.rowNumber ? `Row ${phase.rowNumber.toLocaleString()}: ` : ''}{phase.message}
              </div>
              <div className="truncate text-muted">
                Nothing was imported — the transaction was rolled back.
                {[phase.detail, phase.hint && `Hint: ${phase.hint}`].filter(Boolean).map((t) => ` ${t}`)}
              </div>
              {phase.row && (
                <div className="truncate font-mono text-[11px] text-subtle">
                  {phase.row.map((v) => (v === null ? 'NULL' : JSON.stringify(v))).join(', ')}
                </div>
              )}
            </div>
            <Button variant="ghost" onClick={() => setPhase({ kind: 'idle' })}>Dismiss</Button>
            <Button variant="primary" onClick={runImport}>Retry</Button>
          </>
        ) : (
          <>
            <span className="flex-1 truncate text-xs text-muted">
              {phase.kind === 'cancelled' ? 'Import cancelled — nothing was imported. ' : ''}
              {!file ? 'Choose a file to begin.' : !table ? 'Choose a target table.' : !mapped.length ? 'Map at least one column.'
                : missingRequired.length ? <span className="text-warning">Required columns not mapped: {missingRequired.map((c) => c.name).join(', ')}</span>
                : <>All rows of <b className="text-fg">{file.name}</b> → <b className="text-fg">{schema}.{table}</b> ({mapped.length} columns) in a single transaction.</>}
            </span>
            <Button
              variant="primary"
              icon={<Upload size={13} />}
              disabled={!file || !info?.canInsert || !mapped.length}
              onClick={runImport}
            >
              Import
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function MappingRow({
  col, value, headers, sample, onChange, disabled,
}: { col: TableColumn; value: number | undefined; headers: string[]; sample?: string; onChange: (idx: number) => void; disabled: boolean }) {
  const auto = col.identity || col.isGenerated || (col.default != null);
  return (
    <tr className={cn('border-t border-grid-line', !col.updatable && 'opacity-50')}>
      <td className="px-4 py-1.5">
        <div className="flex items-center gap-1.5">
          {col.isPrimaryKey && <KeyRound size={11} className="text-warning" />}
          <span className="font-medium">{col.name}</span>
          <span className="text-[11px] text-subtle">{shortType(col)}</span>
          {!col.nullable && !auto && <Badge tone="warning">required</Badge>}
          {!col.updatable && <Badge>{col.isGenerated ? 'generated' : 'identity'}</Badge>}
        </div>
      </td>
      <td className="text-center text-subtle">←</td>
      <td className="px-2 py-1">
        <Select
          size="sm"
          className="w-56"
          disabled={disabled || !col.updatable}
          value={value === undefined ? SKIP : String(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          options={[
            { value: SKIP, label: auto ? '— skip (use default) —' : '— skip (NULL) —' },
            ...headers.map((h, i) => ({ value: String(i), label: h })),
          ]}
        />
      </td>
      <td className="max-w-[260px] truncate px-2 py-1 font-mono text-[11.5px] text-muted">
        {sample === undefined ? '' : sample === '' ? <span className="text-subtle">EMPTY</span> : sample}
      </td>
    </tr>
  );
}
