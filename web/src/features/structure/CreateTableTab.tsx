import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Link2, Plus, Sparkles, Table2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { SqlBlock } from '@/components/SqlBlock';
import { Button, Checkbox, DropdownMenu, IconButton, Input, Select, Tooltip } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { uid } from '@/lib/format';
import { useWorkspace } from '@/stores/workspace';
import { openStructure } from '../explorer/actions';
import type { TabProps } from '../common/TabProps';
import { runDdl, toScript, useTypeSuggestions } from './api';
import { useRefTable } from './sections/Constraints';
import { createTableSql, FK_ACTIONS, type ColumnDraft, type NewForeignKey } from './sqlgen';
import { CellInput, TypeInput } from './ui';

interface DesignColumn extends ColumnDraft {
  length: string;
}

const LENGTH_TYPES = /^(varchar|character varying|char|character|bpchar|numeric|decimal|bit|varbit|bit varying|time|timetz|timestamp|timestamptz|interval)$/i;
const INT_TYPES = /^(smallint|integer|int|int2|int4|int8|bigint)$/i;

function col(p: Partial<DesignColumn> = {}): DesignColumn {
  return { key: uid('c'), name: '', type: '', length: '', nullable: true, default: '', comment: '', identity: '', pk: false, unique: false, ...p };
}

const PRESETS: { label: string; hint: string; make: () => DesignColumn }[] = [
  { label: 'id · bigint identity', hint: 'primary key', make: () => col({ name: 'id', type: 'bigint', identity: 'a', pk: true, nullable: false }) },
  { label: 'id · uuid', hint: 'gen_random_uuid()', make: () => col({ name: 'id', type: 'uuid', default: 'gen_random_uuid()', pk: true, nullable: false }) },
  { label: 'name · text', hint: 'not null', make: () => col({ name: 'name', type: 'text', nullable: false }) },
  { label: 'email · text', hint: 'unique', make: () => col({ name: 'email', type: 'text', nullable: false, unique: true }) },
  { label: 'created_at · timestamptz', hint: 'default now()', make: () => col({ name: 'created_at', type: 'timestamptz', default: 'now()', nullable: false }) },
  { label: 'updated_at · timestamptz', hint: 'nullable', make: () => col({ name: 'updated_at', type: 'timestamptz' }) },
  { label: 'data · jsonb', hint: "default '{}'", make: () => col({ name: 'data', type: 'jsonb', default: "'{}'::jsonb", nullable: false }) },
  { label: 'is_active · boolean', hint: 'default true', make: () => col({ name: 'is_active', type: 'boolean', default: 'true', nullable: false }) },
];

function fullType(c: DesignColumn): string {
  const t = c.type.trim();
  const len = c.length.trim();
  if (!len || t.includes('(')) return t;
  const arr = t.match(/(\[\])+$/)?.[0] ?? '';
  return `${t.slice(0, t.length - arr.length)}(${len})${arr}`;
}

/** Create-table designer (kind "create-table"; params { schema }). */
export default function CreateTableTab({ tab }: TabProps) {
  const connId = tab.connId!;
  const db = tab.database!;
  const [schema, setSchema] = useState<string>(tab.params.schema ?? 'public');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [unlogged, setUnlogged] = useState(false);
  const [columns, setColumns] = useState<DesignColumn[]>(() => [PRESETS[0].make(), col()]);
  const [fks, setFks] = useState<NewForeignKey[]>([]);
  const [busy, setBusy] = useState(false);
  const types = useTypeSuggestions(connId, db);
  const schemas = useQuery({ queryKey: ['schemas', connId, db, false], queryFn: () => api.schemas(connId, db, false) });

  const patch = (key: string, p: Partial<DesignColumn>) => setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));
  const move = (i: number, d: number) => setColumns((cs) => {
    const n = [...cs];
    const j = i + d;
    if (j < 0 || j >= n.length) return cs;
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });

  const named = columns.filter((c) => c.name.trim());
  const dupes = new Set(named.map((c) => c.name.trim()).filter((n, i, a) => a.indexOf(n) !== i));
  const missingType = named.filter((c) => !c.type.trim());
  const statements = useMemo(
    () => createTableSql({ schema, name, comment, unlogged, columns: columns.map((c) => ({ ...c, type: fullType(c) })), foreignKeys: fks }),
    [schema, name, comment, unlogged, columns, fks],
  );
  const problems = [
    !name.trim() && 'Enter a table name',
    !named.length && 'Add at least one column',
    dupes.size > 0 && `Duplicate column: ${[...dupes].join(', ')}`,
    missingType.length > 0 && `Choose a type for ${missingType.map((c) => c.name).join(', ')}`,
    fks.some((f) => !f.columns[0] || !f.refTable || !f.refColumns[0]) && 'Complete or remove the unfinished foreign key',
  ].filter(Boolean) as string[];

  const dirty = !!name.trim() || columns.length !== 2 || fks.length > 0 || !!comment;
  useEffect(() => {
    useWorkspace.getState().updateTab(tab.id, { dirty, title: name.trim() ? `New table · ${name.trim()}` : 'New table' });
  }, [dirty, name, tab.id]);

  const create = async () => {
    setBusy(true);
    const ok = await runDdl({ connId, db, title: '', skipConfirm: true, statements, success: `Table ${schema}.${name.trim()} created` });
    setBusy(false);
    if (ok) {
      const ws = useWorkspace.getState();
      ws.updateTab(tab.id, { dirty: false });
      ws.closeTab(tab.id);
      openStructure(connId, db, schema, name.trim(), 'table');
    }
  };

  const colNames = named.map((c) => c.name.trim());

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* designer */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Table2 size={18} /></div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Select className="w-44" value={schema} onChange={(e) => setSchema(e.target.value)} options={(schemas.data ?? [{ name: schema }]).map((s) => ({ value: s.name, label: s.name }))} />
                <span className="text-lg text-subtle">.</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="table_name"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[18px] font-semibold text-fg outline-none placeholder:text-subtle hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </div>
              <CellInput value={comment} onChange={setComment} placeholder="Describe what this table stores (comment)…" className="text-[12.5px]" />
            </div>
          </div>

          {/* columns */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="flex-1 text-[13px] font-semibold text-fg">Columns <span className="ml-1 rounded-full bg-active px-1.5 text-[11px] font-medium text-muted">{named.length}</span></h2>
              <DropdownMenu
                align="end"
                trigger={<Button size="sm" variant="ghost" icon={<Sparkles size={13} />}>Common columns</Button>}
                items={PRESETS.map((p) => ({ label: <span className="flex w-full justify-between gap-4"><span className="font-mono text-[12px]">{p.label}</span><span className="text-[11px] opacity-60">{p.hint}</span></span>, onSelect: () => setColumns((cs) => [...cs.filter((c) => c.name.trim() || c.type.trim()), p.make()]) }))}
              />
              <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setColumns((cs) => [...cs, col()])}>Add column</Button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-separate border-spacing-0 text-[12.5px]">
                <thead>
                  <tr className="text-[11px] tracking-wide text-subtle uppercase">
                    {['', 'Name', 'Type', 'Length', 'Not null', 'Default', 'PK', 'Unique', 'Identity', 'Comment', ''].map((h, i) => (
                      <th key={i} className={cn('h-8 border-b border-border bg-grid-header px-2 text-left font-medium whitespace-nowrap', ['PK', 'Unique', 'Not null'].includes(h) && 'text-center')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c, i) => {
                    const isInt = INT_TYPES.test(c.type.trim());
                    const lengthable = LENGTH_TYPES.test(c.type.trim());
                    return (
                      <tr key={c.key} className="group hover:bg-hover">
                        <td className="w-12 border-b border-grid-line px-1">
                          <span className="flex opacity-0 group-hover:opacity-100">
                            <IconButton label="Move up" size="xs" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} /></IconButton>
                            <IconButton label="Move down" size="xs" disabled={i === columns.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} /></IconButton>
                          </span>
                        </td>
                        <td className="min-w-36 border-b border-grid-line px-1 py-1">
                          <CellInput value={c.name} onChange={(v) => patch(c.key, { name: v })} placeholder="column_name" className={cn(dupes.has(c.name.trim()) && 'border-danger')} />
                        </td>
                        <td className="min-w-40 border-b border-grid-line px-1">
                          <TypeInput value={c.type} onChange={(v) => patch(c.key, { type: v, ...(INT_TYPES.test(v) ? {} : { identity: '' }) })} suggestions={types.data ?? []} invalid={!!c.name.trim() && !c.type.trim()} />
                        </td>
                        <td className="w-20 border-b border-grid-line px-1">
                          <Input size="sm" mono value={c.length} disabled={!lengthable} placeholder={lengthable ? (/numeric|decimal/i.test(c.type) ? '12,2' : 'n') : ''} onChange={(e) => patch(c.key, { length: e.target.value })} />
                        </td>
                        <td className="w-16 border-b border-grid-line text-center">
                          <span className="inline-flex"><Checkbox checked={!c.nullable || !!c.pk} disabled={!!c.pk} onCheckedChange={(v) => patch(c.key, { nullable: !v })} /></span>
                        </td>
                        <td className="min-w-32 border-b border-grid-line px-1">
                          <CellInput mono value={c.identity ? '' : c.default} placeholder={c.identity ? 'identity' : 'expression'} onChange={(v) => patch(c.key, { default: v })} className={cn(c.identity && 'pointer-events-none opacity-50')} />
                        </td>
                        <td className="w-12 border-b border-grid-line text-center">
                          <span className="inline-flex"><Checkbox checked={!!c.pk} onCheckedChange={(v) => patch(c.key, { pk: v, ...(v ? { nullable: false, unique: false } : {}) })} /></span>
                        </td>
                        <td className="w-14 border-b border-grid-line text-center">
                          <span className="inline-flex"><Checkbox checked={!!c.unique} disabled={!!c.pk} onCheckedChange={(v) => patch(c.key, { unique: v })} /></span>
                        </td>
                        <td className="w-32 border-b border-grid-line px-1">
                          <Select size="sm" value={c.identity ?? ''} disabled={!isInt} onChange={(e) => patch(c.key, { identity: e.target.value as DesignColumn['identity'], default: '' })}
                            options={[{ value: '', label: '—' }, { value: 'a', label: 'always' }, { value: 'd', label: 'by default' }]} />
                        </td>
                        <td className="min-w-36 border-b border-grid-line px-1">
                          <CellInput value={c.comment} onChange={(v) => patch(c.key, { comment: v })} placeholder="—" />
                        </td>
                        <td className="w-9 border-b border-grid-line px-1">
                          <IconButton label="Remove column" size="xs" className="hover:text-danger" onClick={() => setColumns((cs) => cs.filter((x) => x.key !== c.key))}><Trash2 size={13} /></IconButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="flex h-9 w-full items-center justify-center gap-1.5 text-xs text-muted hover:bg-hover hover:text-accent" onClick={() => setColumns((cs) => [...cs, col()])}>
                <Plus size={13} /> Add column
              </button>
            </div>
          </section>

          {/* foreign keys */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="flex-1 text-[13px] font-semibold text-fg">Foreign keys <span className="ml-1 rounded-full bg-active px-1.5 text-[11px] font-medium text-muted">{fks.length}</span></h2>
              <Button size="sm" variant="outline" icon={<Link2 size={13} />} disabled={!colNames.length}
                onClick={() => setFks((l) => [...l, { key: uid('f'), name: '', columns: [colNames.find((n) => n.endsWith('_id')) ?? ''], refSchema: schema, refTable: '', refColumns: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }])}>
                Add foreign key
              </Button>
            </div>
            {fks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-subtle">
                No foreign keys. Link a column to another table’s primary key to enforce referential integrity.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {fks.map((f) => (
                  <FkEditor key={f.key} fk={f} connId={connId} db={db} columns={colNames}
                    onChange={(p) => setFks((l) => l.map((x) => (x.key === f.key ? { ...x, ...p } : x)))}
                    onRemove={() => setFks((l) => l.filter((x) => x.key !== f.key))} />
                ))}
              </div>
            )}
          </section>

          <section className="flex items-center gap-6 text-[12.5px]">
            <label className="flex items-center gap-2"><Checkbox checked={unlogged} onCheckedChange={setUnlogged} /> Unlogged <span className="text-subtle">(faster writes, not crash-safe)</span></label>
          </section>
        </div>
      </div>

      {/* SQL preview + actions */}
      <div className="flex max-h-[38%] min-h-[150px] shrink-0 flex-col border-t border-border bg-panel">
        <div className="flex h-11 shrink-0 items-center gap-3 px-4">
          <span className="text-[11px] font-semibold tracking-wider text-subtle uppercase">SQL preview</span>
          {problems.length > 0
            ? <span className="truncate text-[12px] text-warning">{problems[0]}{problems.length > 1 && ` (+${problems.length - 1} more)`}</span>
            : <span className="text-[12px] text-success">Ready to create</span>}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => useWorkspace.getState().newQuery({ connId, database: db, sql: toScript(statements) + '\n', title: `Create ${name || 'table'}` })}>Open in editor</Button>
          <Tooltip content={problems[0]}>
            <span className="flex">
              <Button variant="primary" disabled={problems.length > 0} loading={busy} onClick={create} icon={<Table2 size={13} />}>Create table</Button>
            </span>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
          <SqlBlock sql={toScript(statements)} />
        </div>
      </div>
    </div>
  );
}

function FkEditor({ fk, connId, db, columns, onChange, onRemove }: {
  fk: NewForeignKey; connId: string; db: string; columns: string[]; onChange: (p: Partial<NewForeignKey>) => void; onRemove: () => void;
}) {
  const ref = useRefTable(connId, db, fk.refSchema, fk.refTable);
  // default the referenced column to the target's primary key
  const pk = ref.columns.find((c) => c.isPrimaryKey)?.name;
  useEffect(() => {
    if (fk.refTable && !fk.refColumns[0] && pk) onChange({ refColumns: [pk] });
  }, [fk.refTable, fk.refColumns, pk, onChange]);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel px-3 py-2">
      <Select size="sm" className="w-40" value={fk.columns[0] ?? ''} onChange={(e) => onChange({ columns: [e.target.value] })}
        options={[{ value: '', label: 'column…' }, ...columns.map((c) => ({ value: c, label: c }))]} />
      <span className="text-[12px] text-subtle">references</span>
      <Select size="sm" className="w-32" value={fk.refSchema} onChange={(e) => onChange({ refSchema: e.target.value, refTable: '', refColumns: [] })}
        options={ref.schemas.length ? ref.schemas.map((s) => ({ value: s.name, label: s.name })) : [{ value: fk.refSchema, label: fk.refSchema }]} />
      <Select size="sm" className="w-44" value={fk.refTable} onChange={(e) => onChange({ refTable: e.target.value, refColumns: [] })}
        options={[{ value: '', label: 'table…' }, ...ref.tables.map((o) => ({ value: o.name, label: o.name }))]} />
      <Select size="sm" className="w-36" value={fk.refColumns[0] ?? ''} onChange={(e) => onChange({ refColumns: [e.target.value] })}
        options={[{ value: '', label: 'column…' }, ...ref.columns.map((c) => ({ value: c.name, label: `${c.name}${c.isPrimaryKey ? ' (PK)' : ''}` }))]} />
      <span className="text-[12px] text-subtle">on delete</span>
      <Select size="sm" className="w-32" value={fk.onDelete} onChange={(e) => onChange({ onDelete: e.target.value })} options={FK_ACTIONS.map((a) => ({ value: a, label: a }))} />
      <div className="flex-1" />
      <IconButton label="Remove foreign key" size="xs" className="hover:text-danger" onClick={onRemove}><Trash2 size={13} /></IconButton>
    </div>
  );
}
