import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCheck, Copy, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ConstraintDetail, ConstraintType, ForeignKeyDetail, TableDetails } from '@shared/schema';
import { SqlBlock, highlightSql } from '@/components/SqlBlock';
import { Badge, Button, Checkbox, Dialog, Field, IconButton, Input, Segmented, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { confirmWithOptions, openStructure } from '../../explorer/actions';
import { runDdl } from '../api';
import { fkClause, FK_ACTIONS, fq, qi } from '../sqlgen';
import { Chips, DataTable, EmptyBlock, SectionToolbar, type Col } from '../ui';

const TYPE_LABEL: Record<ConstraintType, string> = { p: 'Primary key', u: 'Unique', f: 'Foreign key', c: 'Check', x: 'Exclusion', t: 'Trigger' };
const TYPE_TONE: Record<ConstraintType, 'warning' | 'accent' | 'neutral' | 'success' | 'danger'> = { p: 'warning', u: 'accent', f: 'neutral', c: 'success', x: 'danger', t: 'neutral' };

function Def({ sql }: { sql: string }) {
  return <span className="font-mono text-[12px] text-muted">{highlightSql(sql)}</span>;
}

async function dropConstraint(connId: string, db: string, t: TableDetails, name: string) {
  const stmts = await confirmWithOptions({
    title: `Drop constraint “${name}”?`,
    options: [{ key: 'cascade', label: 'Cascade', hint: 'Also drop dependent objects (e.g. foreign keys referencing a unique key)' }],
    danger: true,
    confirmLabel: 'Drop',
    build: (o) => [`ALTER TABLE ${fq(t.schema, t.name)} DROP CONSTRAINT ${qi(name)}${o.cascade ? ' CASCADE' : ''}`],
  });
  if (stmts) await runDdl({ connId, db, title: '', skipConfirm: true, statements: stmts, success: `Dropped ${name}` });
}

function constraintMenu(connId: string, db: string, t: TableDetails, c: { name: string; definition: string; validated: boolean; isLocal?: boolean }) {
  return [
    { label: 'Copy definition', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(c.definition) },
    ...(!c.validated ? [{
      label: 'Validate', icon: <CheckCheck size={14} />,
      onSelect: () => runDdl({ connId, db, title: 'Validate constraint', statements: [`ALTER TABLE ${fq(t.schema, t.name)} VALIDATE CONSTRAINT ${qi(c.name)}`], success: `${c.name} validated`, confirmLabel: 'Validate' }),
    }] : []),
    'separator' as const,
    { label: 'Drop constraint…', icon: <Trash2 size={14} />, danger: true, disabled: c.isLocal === false, onSelect: () => dropConstraint(connId, db, t, c.name) },
  ];
}

export function ConstraintsSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const [adding, setAdding] = useState(false);
  const cols: Col<ConstraintDetail>[] = [
    { key: 'name', header: 'Name', render: (c) => <span className="font-medium text-fg">{c.name}</span> },
    { key: 'type', header: 'Type', width: 110, render: (c) => <Badge tone={TYPE_TONE[c.type]}>{TYPE_LABEL[c.type]}</Badge> },
    { key: 'cols', header: 'Columns', render: (c) => <Chips items={c.columns} /> },
    { key: 'def', header: 'Definition', className: 'max-w-[460px] truncate', render: (c) => <span title={c.definition}><Def sql={c.definition} /></span> },
    {
      key: 'flags', header: '', render: (c) => (
        <span className="flex gap-1">
          {!c.validated && <Badge tone="warning">not valid</Badge>}
          {c.deferrable && <Badge>{c.deferred ? 'deferred' : 'deferrable'}</Badge>}
          {!c.isLocal && <Badge>inherited</Badge>}
        </span>
      ),
    },
    {
      key: 'act', header: '', width: 40, render: (c) => c.isLocal && (
        <IconButton label="Drop constraint" size="xs" className="opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => dropConstraint(connId, db, t, c.name)}><Trash2 size={13} /></IconButton>
      ),
    },
  ];
  return (
    <>
      <SectionToolbar title="Constraints" count={t.constraints.length} description="Primary key, unique, check, exclusion and foreign key constraints.">
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add constraint</Button>
      </SectionToolbar>
      <DataTable
        className="min-h-0 flex-1"
        columns={cols}
        rows={t.constraints}
        rowKey={(c) => String(c.oid)}
        rowMenu={(c) => constraintMenu(connId, db, t, c)}
        empty={<EmptyBlock title="No constraints" description="Add a primary key, unique or check constraint to protect data integrity." />}
      />
      {adding && <ConstraintDialog t={t} connId={connId} db={db} onClose={() => setAdding(false)} />}
    </>
  );
}

function ColumnPicker({ t, value, onChange }: { t: TableDetails; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex max-h-44 flex-col overflow-auto rounded-md border border-border">
      {t.columns.map((c) => {
        const idx = value.indexOf(c.name);
        return (
          <label key={c.name} className="flex h-7 cursor-pointer items-center gap-2 px-2.5 text-[12.5px] hover:bg-hover">
            <Checkbox checked={idx >= 0} onCheckedChange={(v) => onChange(v ? [...value, c.name] : value.filter((x) => x !== c.name))} />
            <span className="flex-1">{c.name}</span>
            <span className="font-mono text-[11px] text-subtle">{c.dataType}</span>
            {idx >= 0 && value.length > 1 && <span className="w-4 text-right text-[11px] text-accent">{idx + 1}</span>}
          </label>
        );
      })}
    </div>
  );
}

function ConstraintDialog({ t, connId, db, onClose }: { t: TableDetails; connId: string; db: string; onClose: () => void }) {
  const hasPk = t.constraints.some((c) => c.type === 'p');
  const [type, setType] = useState<'p' | 'u' | 'c' | 'x'>(hasPk ? 'u' : 'p');
  const [cols, setCols] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [check, setCheck] = useState('');
  const [excl, setExcl] = useState('USING gist (col WITH =)');
  const [notValid, setNotValid] = useState(false);
  const [deferrable, setDeferrable] = useState(false);
  const [busy, setBusy] = useState(false);
  const auto = `${t.name}_${type === 'p' ? 'pkey' : `${cols.join('_') || (type === 'c' ? 'check' : 'excl')}_${type === 'u' ? 'key' : type === 'c' ? 'check' : 'excl'}`}`.replace(/__+/g, '_').slice(0, 63);
  const body = type === 'p' ? `PRIMARY KEY (${cols.map(qi).join(', ')})`
    : type === 'u' ? `UNIQUE (${cols.map(qi).join(', ')})`
    : type === 'c' ? `CHECK (${check})`
    : `EXCLUDE ${excl}`;
  const sql = `ALTER TABLE ${fq(t.schema, t.name)} ADD CONSTRAINT ${qi(name || auto)} ${body}${deferrable && type !== 'c' ? ' DEFERRABLE' : ''}${notValid && type === 'c' ? ' NOT VALID' : ''}`;
  const valid = type === 'c' ? !!check.trim() : type === 'x' ? !!excl.trim() : cols.length > 0;
  const submit = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements: [sql], success: `Constraint ${name || auto} added` });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add constraint" description={`on ${t.schema}.${t.name}`} width={580}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>Add constraint</Button></>}>
      <div className="flex flex-col gap-4">
        <Segmented value={type} onChange={setType} options={[
          ...(!hasPk ? [{ value: 'p' as const, label: 'Primary key' }] : []),
          { value: 'u' as const, label: 'Unique' },
          { value: 'c' as const, label: 'Check' },
          { value: 'x' as const, label: 'Exclusion' },
        ]} />
        <Field label="Name"><Input mono value={name} placeholder={auto} onChange={(e) => setName(e.target.value)} /></Field>
        {(type === 'p' || type === 'u') && <Field label="Columns"><ColumnPicker t={t} value={cols} onChange={setCols} /></Field>}
        {type === 'c' && <Field label="Check expression" hint="e.g. price >= 0 AND price < 1000000"><Input mono value={check} onChange={(e) => setCheck(e.target.value)} autoFocus /></Field>}
        {type === 'x' && <Field label="Exclusion definition" hint="e.g. USING gist (room WITH =, during WITH &&)"><Input mono value={excl} onChange={(e) => setExcl(e.target.value)} /></Field>}
        <div className="flex gap-6 text-[12.5px]">
          {type === 'c' && <label className="flex items-center gap-2"><Checkbox checked={notValid} onCheckedChange={setNotValid} /> NOT VALID <span className="text-subtle">(skip checking existing rows)</span></label>}
          {type !== 'c' && <label className="flex items-center gap-2"><Checkbox checked={deferrable} onCheckedChange={setDeferrable} /> Deferrable</label>}
        </div>
        <SqlBlock sql={sql + ';'} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ foreign keys

function FkRow({ fk, incoming, connId, db, schema }: { fk: ForeignKeyDetail; incoming: boolean; connId: string; db: string; schema: string }) {
  const other = incoming ? { s: fk.fromSchema, t: fk.fromTable } : { s: fk.toSchema, t: fk.toTable };
  const label = (s: string, n: string) => (s === schema ? n : `${s}.${n}`);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-fg">{incoming ? <button className="text-info hover:underline" onClick={() => openStructure(connId, db, other.s, other.t)}>{label(other.s, other.t)}</button> : <span className="text-muted">this</span>}</span>
      <Chips items={fk.fromColumns} />
      <ArrowRight size={12} className="text-subtle" />
      <span>{incoming ? <span className="text-muted">this</span> : <button className="text-info hover:underline" onClick={() => openStructure(connId, db, other.s, other.t)}>{label(other.s, other.t)}</button>}</span>
      <Chips items={fk.toColumns} />
    </span>
  );
}

const actionBadge = (a: string) => a && a !== 'NO ACTION' ? <Badge tone={a === 'CASCADE' ? 'danger' : 'neutral'}>{a}</Badge> : <span className="text-subtle">—</span>;

export function ForeignKeysSection({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const [adding, setAdding] = useState(false);
  const mk = (incoming: boolean): Col<ForeignKeyDetail>[] => [
    { key: 'name', header: 'Name', render: (f) => <span className="font-medium text-fg">{f.name}</span> },
    { key: 'rel', header: incoming ? 'From' : 'References', render: (f) => <FkRow fk={f} incoming={incoming} connId={connId} db={db} schema={t.schema} /> },
    { key: 'del', header: 'On delete', width: 110, render: (f) => actionBadge(f.onDelete) },
    { key: 'upd', header: 'On update', width: 110, render: (f) => actionBadge(f.onUpdate) },
    { key: 'flags', header: '', width: 80, render: (f) => !f.validated && <Badge tone="warning">not valid</Badge> },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <SectionToolbar title="Outgoing" count={t.foreignKeys.length} description={`Columns of ${t.name} that reference other tables.`}>
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add foreign key</Button>
      </SectionToolbar>
      <DataTable columns={[...mk(false), {
        key: 'act', header: '', width: 40,
        render: (f) => <IconButton label="Drop foreign key" size="xs" className="opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => dropConstraint(connId, db, t, f.name)}><Trash2 size={13} /></IconButton>,
      }]} rows={t.foreignKeys} rowKey={(f) => String(f.oid)}
        rowMenu={(f) => constraintMenu(connId, db, t, f)}
        empty={<div className="px-4 pb-4 text-xs text-subtle">This table does not reference other tables.</div>} />
      <SectionToolbar title="Incoming" count={t.referencedBy.length} description={`Tables whose rows reference ${t.name}.`} />
      <DataTable columns={mk(true)} rows={t.referencedBy} rowKey={(f) => String(f.oid)}
        rowMenu={(f) => [{ label: 'Copy definition', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(f.definition) }, { label: `Open ${f.fromTable}`, onSelect: () => openStructure(connId, db, f.fromSchema, f.fromTable) }]}
        empty={<div className="px-4 pb-4 text-xs text-subtle">No other table references {t.name}.</div>} />
      {adding && <ForeignKeyDialog t={t} connId={connId} db={db} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Pick a referenced table + columns; shared with the create-table designer. */
export function useRefTable(connId: string, db: string, schema: string, table: string) {
  const schemas = useQuery({ queryKey: ['schemas', connId, db, false], queryFn: () => api.schemas(connId, db, false) });
  const objects = useQuery({ queryKey: ['objects', connId, db, schema], queryFn: () => api.objects(connId, db, schema), enabled: !!schema });
  const columns = useQuery({ queryKey: ['columns', connId, db, schema, table], queryFn: () => api.columns(connId, db, schema, table), enabled: !!schema && !!table });
  const tables = (objects.data ?? []).filter((o) => o.kind === 'table' || o.kind === 'partitioned_table');
  return { schemas: schemas.data ?? [], tables, columns: columns.data ?? [] };
}

function ForeignKeyDialog({ t, connId, db, onClose }: { t: TableDetails; connId: string; db: string; onClose: () => void }) {
  const [cols, setCols] = useState<string[]>([]);
  const [refSchema, setRefSchema] = useState(t.schema);
  const [refTable, setRefTable] = useState('');
  const [refCols, setRefCols] = useState<string[]>([]);
  const [onDelete, setOnDelete] = useState('NO ACTION');
  const [onUpdate, setOnUpdate] = useState('NO ACTION');
  const [name, setName] = useState('');
  const [notValid, setNotValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRefTable(connId, db, refSchema, refTable);
  // default referenced columns: the referenced table's primary key
  const pkCols = useMemo(() => ref.columns.filter((c) => c.isPrimaryKey).map((c) => c.name), [ref.columns]);
  const effRef = cols.map((_, i) => refCols[i] ?? pkCols[i] ?? '');
  const auto = `${t.name}_${cols.join('_') || 'ref'}_fkey`.slice(0, 63);
  const sql = `ALTER TABLE ${fq(t.schema, t.name)} ADD CONSTRAINT ${qi(name || auto)} ${fkClause({ columns: cols, refSchema, refTable: refTable || '…', refColumns: effRef, onDelete, onUpdate })}${notValid ? ' NOT VALID' : ''}`;
  const valid = cols.length > 0 && !!refTable && effRef.every(Boolean);
  const submit = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements: [sql], success: `Foreign key ${name || auto} added` });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add foreign key" description={`on ${t.schema}.${t.name}`} width={640}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>Add foreign key</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input mono value={name} placeholder={auto} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Referenced schema">
            <Select value={refSchema} onChange={(e) => { setRefSchema(e.target.value); setRefTable(''); setRefCols([]); }} options={ref.schemas.map((s) => ({ value: s.name, label: s.name }))} />
          </Field>
          <Field label="Referenced table">
            <Select value={refTable} onChange={(e) => { setRefTable(e.target.value); setRefCols([]); }} options={[{ value: '', label: 'Choose table…' }, ...ref.tables.map((o) => ({ value: o.name, label: o.name }))]} />
          </Field>
        </div>
        <Field label="Columns">
          <div className="flex flex-col gap-1.5">
            <ColumnPicker t={t} value={cols} onChange={setCols} />
            {cols.length > 0 && refTable && (
              <div className="flex flex-col gap-1 rounded-md bg-sunken p-2">
                {cols.map((c, i) => (
                  <div key={c} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-40 truncate font-mono">{c}</span>
                    <ArrowRight size={12} className="text-subtle" />
                    <Select size="sm" className="flex-1" value={effRef[i]} onChange={(e) => setRefCols((r) => { const n = [...effRef]; n[i] = e.target.value; return n; })}
                      options={[{ value: '', label: 'Choose column…' }, ...ref.columns.map((rc) => ({ value: rc.name, label: `${rc.name} · ${rc.dataType}${rc.isPrimaryKey ? ' · PK' : ''}` }))]} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="On delete"><Select value={onDelete} onChange={(e) => setOnDelete(e.target.value)} options={FK_ACTIONS.map((a) => ({ value: a, label: a }))} /></Field>
          <Field label="On update"><Select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)} options={FK_ACTIONS.map((a) => ({ value: a, label: a }))} /></Field>
        </div>
        <label className={cn('flex items-center gap-2 text-[12.5px]')}><Checkbox checked={notValid} onCheckedChange={setNotValid} /> NOT VALID <span className="text-subtle">(don’t check existing rows now)</span></label>
        <SqlBlock sql={sql + ';'} />
      </div>
    </Dialog>
  );
}
