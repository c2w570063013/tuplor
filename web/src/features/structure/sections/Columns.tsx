import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ColumnDetail, TableDetails, TypeSuggestion } from '@shared/schema';
import { Badge, Button, Checkbox, IconButton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { uid } from '@/lib/format';
import { openStructure } from '../../explorer/actions';
import { changedFields, type ColumnDraft } from '../sqlgen';
import { CellInput, DataTable, FkIcon, Mono, PkIcon, SectionToolbar, TypeInput, TypeText, type Col } from '../ui';

function pct(n: number | null) {
  if (n == null) return '';
  return n === 0 ? '0%' : n < 0.001 ? '<0.1%' : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}
function distinct(n: number | null, rows: number) {
  if (n == null) return '';
  if (n < 0) return n === -1 ? 'unique' : `~${Math.round(-n * rows).toLocaleString()}`;
  return Math.round(n).toLocaleString();
}

export function ColumnsView({ t, connId, db }: { t: TableDetails; connId: string; db: string }) {
  const rows = t.stats.estRows;
  const cols: Col<ColumnDetail>[] = [
    { key: 'n', header: '#', width: 40, align: 'right', className: 'text-subtle', render: (c) => c.attnum },
    {
      key: 'name', header: 'Name', render: (c) => (
        <span className="flex items-center gap-1.5">
          {c.isPrimaryKey && <PkIcon />}
          {!c.isPrimaryKey && c.fk && <FkIcon />}
          <span className={cn('font-medium text-fg', c.inherited && 'text-muted')}>{c.name}</span>
          {c.inherited && <Badge>inherited</Badge>}
        </span>
      ),
    },
    {
      key: 'type', header: 'Type', render: (c) => (
        <span className="flex items-center gap-1.5">
          <TypeText type={c.dataType} />
          {c.typeKind === 'e' && <Badge tone="success">enum</Badge>}
          {c.typeKind === 'd' && <Badge tone="success">domain</Badge>}
          {c.collation && <Badge>{c.collation}</Badge>}
        </span>
      ),
    },
    {
      key: 'null', header: 'Nullable', width: 90, render: (c) => (c.nullable ? <span className="text-subtle">null</span> : <Badge tone="warning">NOT NULL</Badge>),
    },
    {
      key: 'default', header: 'Default', render: (c) =>
        c.identity ? <Badge tone="accent">identity {c.identity === 'a' ? 'always' : 'by default'}</Badge>
          : c.generated ? <span className="flex items-center gap-1.5"><Badge tone="accent">generated</Badge><Mono className="text-muted">{c.generatedExpr}</Mono></span>
          : c.default ? <Mono className="text-syntax-string" title={c.default}>{c.default}</Mono> : null,
      className: 'max-w-[260px] truncate',
    },
    {
      key: 'ref', header: 'References', render: (c) => c.fk && (
        <button className="inline-flex items-center gap-1 text-info hover:underline" onClick={() => openStructure(connId, db, c.fk!.schema, c.fk!.table)}>
          <FkIcon /> {c.fk.schema === t.schema ? '' : `${c.fk.schema}.`}{c.fk.table}.{c.fk.column}
        </button>
      ),
    },
    { key: 'comment', header: 'Comment', className: 'max-w-[280px] truncate text-muted', render: (c) => <span title={c.comment ?? undefined}>{c.comment}</span> },
    { key: 'nulls', header: <Tooltip content="Fraction of NULL values (pg_stats)"><span>Nulls</span></Tooltip>, width: 70, align: 'right', className: 'text-muted', render: (c) => pct(c.nullFrac) },
    { key: 'distinct', header: <Tooltip content="Estimated distinct values (pg_stats)"><span>Distinct</span></Tooltip>, width: 90, align: 'right', className: 'text-muted', render: (c) => distinct(c.nDistinct, rows) },
  ];
  return (
    <>
      <SectionToolbar title="Columns" count={t.columns.length} description="Double-click a row or press Edit to change columns." />
      <DataTable className="min-h-0 flex-1" columns={cols} rows={t.columns} rowKey={(c) => String(c.attnum)} />
    </>
  );
}

export function newDraft(): ColumnDraft {
  return { key: uid('n'), name: '', type: '', nullable: true, default: '', comment: '' };
}

export function ColumnsEditor({
  drafts, setDrafts, types,
}: {
  drafts: ColumnDraft[];
  setDrafts: (fn: (d: ColumnDraft[]) => ColumnDraft[]) => void;
  types: TypeSuggestion[];
}) {
  const patch = (key: string, p: Partial<ColumnDraft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const remove = (d: ColumnDraft) => (d.orig ? patch(d.key, { drop: !d.drop }) : setDrafts((ds) => ds.filter((x) => x.key !== d.key)));
  const cols: Col<ColumnDraft>[] = [
    {
      key: 'state', header: '', width: 28, render: (d) => (
        <span className={cn('block h-2 w-2 rounded-full', !d.orig ? 'bg-success' : d.drop ? 'bg-danger' : changedFields(d).size ? 'bg-warning' : 'bg-transparent')} />
      ),
    },
    {
      key: 'name', header: 'Name', width: '20%', render: (d) => {
        const ch = changedFields(d);
        return (
          <span className="flex items-center gap-1">
            {d.orig?.isPrimaryKey && <PkIcon />}
            <CellInput value={d.name} onChange={(v) => patch(d.key, { name: v })} placeholder="column_name" changed={ch.has('name')} autoFocus={!d.orig && !d.name} />
          </span>
        );
      },
    },
    {
      key: 'type', header: 'Type', width: '20%', render: (d) => (
        <TypeInput value={d.type} onChange={(v) => patch(d.key, { type: v })} suggestions={types} invalid={!d.orig && !!d.name && !d.type}
          className={cn('border-transparent bg-transparent hover:border-border-strong', changedFields(d).has('type') && 'border-warning/50 bg-warning-soft')} />
      ),
    },
    {
      key: 'nn', header: 'Not null', width: 80, align: 'center', render: (d) => (
        <span className={cn('inline-flex rounded p-1', changedFields(d).has('nullable') && 'bg-warning-soft')}>
          <Checkbox checked={!d.nullable} onCheckedChange={(v) => patch(d.key, { nullable: !v })} disabled={d.orig?.isPrimaryKey} />
        </span>
      ),
    },
    {
      key: 'default', header: 'Default', width: '20%', render: (d) =>
        d.orig?.identity ? <Badge tone="accent">identity</Badge>
          : d.orig?.generated ? <Badge tone="accent">generated</Badge>
          : <CellInput mono value={d.default} onChange={(v) => patch(d.key, { default: v })} placeholder="expression" changed={changedFields(d).has('default')} />,
    },
    {
      key: 'comment', header: 'Comment', render: (d) => (
        <CellInput value={d.comment} onChange={(v) => patch(d.key, { comment: v })} placeholder="—" changed={changedFields(d).has('comment')} />
      ),
    },
    {
      key: 'act', header: '', width: 44, align: 'center', render: (d) =>
        d.drop ? (
          <IconButton label="Restore column" size="xs" onClick={() => remove(d)}><RotateCcw size={13} /></IconButton>
        ) : (
          <IconButton label={d.orig ? 'Drop column' : 'Remove'} size="xs" disabled={d.orig?.inherited} className="hover:text-danger" onClick={() => remove(d)}><Trash2 size={13} /></IconButton>
        ),
    },
  ];
  return (
    <>
      <SectionToolbar title="Edit columns" count={drafts.filter((d) => !d.drop).length} description="Changes are collected below and applied together in one transaction.">
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setDrafts((ds) => [...ds, newDraft()])}>Add column</Button>
      </SectionToolbar>
      <DataTable
        className="min-h-0 flex-1"
        dense
        columns={cols}
        rows={drafts}
        rowKey={(d) => d.key}
        rowClassName={(d) => cn(d.drop && 'bg-danger-soft opacity-60 [&_input]:line-through', !d.orig && 'bg-success-soft/50')}
      />
      <button
        className="mx-4 my-2 flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong text-xs text-muted hover:border-accent hover:text-accent"
        onClick={() => setDrafts((ds) => [...ds, newDraft()])}
      >
        <Plus size={13} /> Add column
      </button>
    </>
  );
}
