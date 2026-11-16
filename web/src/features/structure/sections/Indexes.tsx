import { ArrowDownAZ, ArrowUpAZ, Copy, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { IndexDetail, TableDetails } from '@shared/schema';
import { SqlBlock } from '@/components/SqlBlock';
import { Badge, Button, Checkbox, Dialog, Field, IconButton, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { dropObject } from '../../explorer/actions';
import { runDdl } from '../api';
import { createIndexSql, fq, INDEX_METHODS, suggestIndexName } from '../sqlgen';
import { Chips, DataTable, EmptyBlock, Mono, SectionToolbar, type Col } from '../ui';

export function IndexesSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const [creating, setCreating] = useState(false);
  const maxSize = Math.max(1, ...t.indexes.map((i) => i.sizeBytes));
  const cols: Col<IndexDetail>[] = [
    {
      key: 'name', header: 'Name', render: (i) => (
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-fg">{i.name}</span>
          {i.isPrimary && <Badge tone="warning">primary</Badge>}
          {i.isUnique && !i.isPrimary && <Badge tone="accent">unique</Badge>}
          {!i.isValid && <Badge tone="danger">invalid</Badge>}
          {i.isInherited && <Badge>partition</Badge>}
        </span>
      ),
    },
    { key: 'cols', header: 'Columns', render: (i) => <span className="flex flex-wrap items-center gap-1"><Chips items={i.columns} />{i.include.length > 0 && <><span className="text-[11px] text-subtle">include</span><Chips items={i.include} /></>}</span> },
    { key: 'method', header: 'Method', width: 80, render: (i) => <Mono className="text-muted">{i.method}</Mono> },
    { key: 'where', header: 'Predicate', className: 'max-w-[220px] truncate', render: (i) => i.predicate && <Mono className="text-muted" title={i.predicate}>{i.predicate}</Mono> },
    {
      key: 'size', header: 'Size', width: 130, align: 'right', render: (i) => (
        <span className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-active"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(3, (i.sizeBytes / maxSize) * 100)}%` }} /></span>
          <span className="w-14">{formatBytes(i.sizeBytes)}</span>
        </span>
      ),
    },
    { key: 'scans', header: 'Scans', width: 80, align: 'right', render: (i) => (i.scans == null ? '—' : i.scans === 0 ? <span className="text-warning" title="Never used since stats reset">0</span> : formatCount(i.scans)) },
    {
      key: 'act', header: '', width: 40, render: (i) => !i.constraint && !i.isInherited && (
        <IconButton label="Drop index" size="xs" className="opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => dropObject(connId, db, 'index', t.schema, i.name)}><Trash2 size={13} /></IconButton>
      ),
    },
  ];
  return (
    <>
      <SectionToolbar title="Indexes" count={t.indexes.length} description={t.indexes.length ? `${formatBytes(t.stats.indexBytes)} total` : undefined}>
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setCreating(true)}>New index</Button>
      </SectionToolbar>
      <DataTable
        className="min-h-0 flex-1"
        columns={cols}
        rows={t.indexes}
        rowKey={(i) => String(i.oid)}
        empty={<EmptyBlock title="No indexes" description="Add an index to speed up lookups, joins and sorting." />}
        rowMenu={(i) => [
          { label: 'Copy definition', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(i.definition + ';') },
          { label: 'Reindex', icon: <RefreshCw size={14} />, onSelect: () => runDdl({ connId, db, title: 'Reindex', statements: [`REINDEX INDEX ${fq(t.schema, i.name)}`], transaction: false, success: `Reindexed ${i.name}`, confirmLabel: 'Run' }) },
          'separator',
          i.constraint
            ? { label: `Backs constraint ${i.constraint}`, disabled: true }
            : { label: 'Drop index…', icon: <Trash2 size={14} />, danger: true, disabled: i.isInherited, onSelect: () => dropObject(connId, db, 'index', t.schema, i.name) },
        ]}
      />
      {creating && <IndexDialog t={t} connId={connId} db={db} onClose={() => setCreating(false)} />}
    </>
  );
}

function IndexDialog({ t, connId, db, onClose }: { t: TableDetails; connId: string; db: string; onClose: () => void }) {
  const [cols, setCols] = useState<{ expr: string; desc?: boolean }[]>([{ expr: '' }]);
  const [method, setMethod] = useState('btree');
  const [unique, setUnique] = useState(false);
  const [concurrently, setConcurrently] = useState(false);
  const [where, setWhere] = useState('');
  const [include, setInclude] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const autoName = suggestIndexName(t.name, cols.map((c) => c.expr).filter(Boolean), unique);
  const sql = useMemo(
    () => createIndexSql({ schema: t.schema, table: t.name, name: name || autoName, method, unique, columns: cols, include, where, concurrently }),
    [t, name, autoName, method, unique, cols, include, where, concurrently],
  );
  const valid = cols.some((c) => c.expr.trim());
  const colOptions = [{ value: '', label: 'Choose column…' }, ...t.columns.map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.dataType}` }))];
  const unused = t.columns.filter((c) => !cols.some((x) => x.expr === c.name) && !include.includes(c.name));

  const submit = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements: [sql], transaction: !concurrently, success: `Index ${name || autoName} created` });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New index"
      description={`on ${t.schema}.${t.name}`}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>Create index</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Name"><Input value={name} placeholder={autoName} onChange={(e) => setName(e.target.value)} mono /></Field>
          <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)} options={INDEX_METHODS.map((m) => ({ value: m, label: m }))} /></Field>
        </div>
        <Field label="Columns / expressions" hint="Pick a column or type an expression such as lower(email).">
          <div className="flex flex-col gap-1.5">
            {cols.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-4 text-right text-[11px] text-subtle">{i + 1}</span>
                <Select className="w-52" size="sm" value={t.columns.some((x) => x.name === c.expr) ? c.expr : ''} options={colOptions}
                  onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)))} />
                <Input size="sm" mono className="flex-1" value={c.expr} placeholder="or expression" onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)))} />
                {method === 'btree' && (
                  <IconButton label={c.desc ? 'Descending' : 'Ascending'} active={c.desc} onClick={() => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, desc: !x.desc } : x)))}>
                    {c.desc ? <ArrowUpAZ size={14} /> : <ArrowDownAZ size={14} />}
                  </IconButton>
                )}
                <IconButton label="Remove" disabled={cols.length === 1} onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}><X size={14} /></IconButton>
              </div>
            ))}
            <button className="ml-5 flex h-7 w-fit items-center gap-1 rounded px-1.5 text-xs text-accent hover:bg-accent-soft" onClick={() => setCols((cs) => [...cs, { expr: '' }])}>
              <Plus size={12} /> Add column
            </button>
          </div>
        </Field>
        {method === 'btree' && (
          <Field label="Include (covering columns)">
            <div className="flex flex-wrap gap-1.5">
              {include.map((c) => (
                <button key={c} className="flex h-6 items-center gap-1 rounded bg-accent-soft px-2 font-mono text-[11.5px] text-accent" onClick={() => setInclude((l) => l.filter((x) => x !== c))}>{c}<X size={11} /></button>
              ))}
              <Select size="sm" className="w-44" value="" options={[{ value: '', label: '+ include column' }, ...unused.map((c) => ({ value: c.name, label: c.name }))]} onChange={(e) => e.target.value && setInclude((l) => [...l, e.target.value])} />
            </div>
          </Field>
        )}
        <Field label="Partial index condition (WHERE)"><Input mono value={where} placeholder="e.g. deleted_at IS NULL" onChange={(e) => setWhere(e.target.value)} /></Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={unique} onCheckedChange={setUnique} /> Unique</label>
          <label className={cn('flex items-center gap-2 text-[12.5px]', t.kind === 'partitioned_table' && 'opacity-50')}>
            <Checkbox checked={concurrently} disabled={t.kind === 'partitioned_table'} onCheckedChange={setConcurrently} /> Concurrently <span className="text-subtle">(no write lock, slower)</span>
          </label>
        </div>
        <SqlBlock sql={sql + ';'} />
      </div>
    </Dialog>
  );
}
