import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, Ellipsis, FileCode2, GripVertical, Pencil, Play, Plus, RefreshCw, RotateCcw, Table2, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type {
  DependencyRef, DomainDetails, EnumDetails, FunctionDetails, GrantDetail, ObjectDetails, SequenceDetails, TypeUsage, ViewDetails,
} from '@shared/schema';
import type { DbObjectKind } from '@shared/types';
import { Badge, Button, DropdownMenu, IconButton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { prompt } from '@/stores/dialogs';
import { useWorkspace } from '@/stores/workspace';
import { isTableKind, objectMenu, openData, openObjectByName, openStructure, routineToEditor } from '../explorer/actions';
import { objectIcon } from '../explorer/ExplorerTree';
import type { TabProps } from '../common/TabProps';
import { runDdl, schemaApi, schemaKeys } from './api';
import { fq, lit, qi } from './sqlgen';
import { Card, CodeView, CopyButton, DataTable, EmptyBlock, ErrorState, KeyValue, Loading, Mono, SectionToolbar, StatCard, TypeText } from './ui';

type Params = { schema: string; name: string; objectKind: DbObjectKind; oid?: number; args?: string; section?: string };

/** Details tab for views, materialized views, functions, procedures, sequences, enums, domains and composite types. */
export default function ObjectTab({ tab }: TabProps) {
  const p = tab.params as Params;
  const connId = tab.connId!;
  const db = tab.database!;
  const oidQ = useQuery({
    queryKey: ['objects', connId, db, p.schema, '~resolve', p.objectKind, p.name],
    queryFn: () => schemaApi.resolve(connId, db, p.schema, p.name, p.objectKind),
    enabled: !p.oid,
  });
  const oid = p.oid ?? oidQ.data;
  const q = useQuery({
    queryKey: schemaKeys.object(connId, db, p.objectKind, oid ?? 0),
    queryFn: () => schemaApi.object(connId, db, p.objectKind, oid!),
    enabled: !!oid,
  });
  const o = q.data;
  if (oidQ.error) return <ErrorState error={oidQ.error} onRetry={() => oidQ.refetch()} />;
  if (q.isLoading || (!oid && oidQ.isLoading)) return <Loading label={`Loading ${p.schema}.${p.name}…`} />;
  if (q.error || !o) return <ErrorState error={q.error ?? new Error('Object not found — it may have been dropped or renamed.')} onRetry={() => q.refetch()} />;

  const sections = sectionsFor(o);
  const section = sections.find((s) => s.id === p.section)?.id ?? sections[0].id;
  const setSection = (s: string) => useWorkspace.getState().updateParams(tab.id, { section: s });
  const ctx = { connId, db, o };

  return (
    <div className="flex h-full flex-col">
      <Header ctx={ctx} refetch={() => q.refetch()} fetching={q.isFetching} />
      <nav className="-mt-px flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-5" role="tablist">
        {sections.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)}
            className={cn('flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[12.5px] font-medium transition-colors', section === s.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
            {s.label}
            {s.count != null && <span className={cn('rounded-full px-1.5 text-[10.5px] tabular-nums', section === s.id ? 'bg-accent-soft text-accent' : 'bg-active text-subtle')}>{s.count}</span>}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">
        {sections.find((s) => s.id === section)!.render(ctx)}
      </div>
    </div>
  );
}

interface Ctx { connId: string; db: string; o: ObjectDetails }
interface Sec { id: string; label: string; count?: number; render: (c: Ctx) => ReactNode }

function sectionsFor(o: ObjectDetails): Sec[] {
  const ddl: Sec = { id: 'ddl', label: 'DDL', render: (c) => <DdlView ctx={c} /> };
  switch (o.kind) {
    case 'view':
    case 'materialized_view':
      return [
        { id: 'definition', label: 'Definition', render: (c) => <ViewDefinition ctx={c} /> },
        { id: 'columns', label: 'Columns', count: o.columns.length, render: () => <ColumnsList cols={o.columns} /> },
        { id: 'deps', label: 'Dependencies', count: o.dependents.length + o.dependsOn.length, render: (c) => <Dependencies ctx={c} v={o} /> },
        ...(o.kind === 'materialized_view' ? [{ id: 'indexes', label: 'Indexes', count: o.indexes.length, render: () => <IndexList v={o} /> }] : []),
        { id: 'permissions', label: 'Permissions', render: () => <Grants grants={o.grants} owner={o.owner} /> },
        ddl,
      ];
    case 'function':
    case 'procedure':
    case 'aggregate':
      return [
        ...(o.definition ? [{ id: 'definition', label: 'Definition', render: () => <CodeView className="h-full" value={o.definition!} /> }] : []),
        { id: 'details', label: 'Details', render: (c) => <FunctionDetailsView ctx={c} f={o} /> },
        { id: 'permissions', label: 'Permissions', render: () => <Grants grants={o.grants} owner={o.owner} /> },
        ddl,
      ];
    case 'sequence':
      return [{ id: 'overview', label: 'Overview', render: (c) => <SequenceView ctx={c} s={o} /> }, ddl];
    case 'enum':
      return [
        { id: 'values', label: 'Values', count: o.values.length, render: (c) => <EnumValues ctx={c} e={o} /> },
        { id: 'usage', label: 'Used by', count: o.usedBy.length, render: (c) => <Usage ctx={c} usage={o.usedBy} /> },
        ddl,
      ];
    case 'domain':
      return [
        { id: 'overview', label: 'Overview', render: (c) => <DomainView ctx={c} d={o} /> },
        { id: 'usage', label: 'Used by', count: o.usedBy.length, render: (c) => <Usage ctx={c} usage={o.usedBy} /> },
        ddl,
      ];
    case 'type':
      return [
        { id: 'attributes', label: 'Attributes', count: o.attributes.length, render: () => <ColumnsList cols={o.attributes} title="Attributes" /> },
        { id: 'usage', label: 'Used by', count: o.usedBy.length, render: (c) => <Usage ctx={c} usage={o.usedBy} /> },
        ddl,
      ];
  }
}

const KIND_LABEL: Record<string, string> = {
  view: 'view', materialized_view: 'materialized view', function: 'function', procedure: 'procedure', aggregate: 'aggregate',
  sequence: 'sequence', enum: 'enum type', domain: 'domain', type: 'composite type',
};

function Header({ ctx, refetch, fetching }: { ctx: Ctx; refetch: () => void; fetching: boolean }) {
  const { connId, db, o } = ctx;
  const args = 'identityArgs' in o ? o.identityArgs : undefined;
  const dbObj = { oid: o.oid, schema: o.schema, name: o.name, kind: o.kind as DbObjectKind, args };
  const isRoutine = o.kind === 'function' || o.kind === 'procedure';
  const isView = o.kind === 'view' || o.kind === 'materialized_view';
  return (
    <div className="shrink-0 px-5 pt-4 pb-2">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft [&_svg]:h-[18px] [&_svg]:w-[18px]">{objectIcon(o.kind as DbObjectKind)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[11.5px] text-subtle"><span>{db}</span><ChevronRight size={11} /><span>{o.schema}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[17px] font-semibold text-fg">{o.name}{args !== undefined && <span className="font-normal text-muted">({args})</span>}</h1>
            <Badge>{KIND_LABEL[o.kind]}</Badge>
            {o.kind === 'materialized_view' && o.isPopulated === false && <Badge tone="warning">not populated</Badge>}
            {fetching && <Spinner size={12} className="text-subtle" />}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
            <span>owner {o.owner}</span>
            {'language' in o && <span>{o.language}</span>}
            {'result' in o && o.result && <span>returns <span className="font-mono text-syntax-keyword">{o.result}</span></span>}
            {o.kind === 'materialized_view' && o.sizeBytes != null && <span>{formatBytes(o.sizeBytes)}</span>}
            {o.kind === 'domain' && <span>over <span className="font-mono text-syntax-keyword">{o.baseType}</span></span>}
          </div>
          {o.comment && <p className="mt-1.5 max-w-3xl text-[12.5px] text-muted">{o.comment}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton label="Refresh" onClick={refetch}><RefreshCw size={14} /></IconButton>
          {isView && <Button size="sm" variant="outline" icon={<Table2 size={13} />} onClick={() => openData(connId, db, dbObj)}>Data</Button>}
          {o.kind === 'materialized_view' && (
            <Button size="sm" variant="outline" icon={<RotateCcw size={13} />} onClick={() => runDdl({ connId, db, title: 'Refresh materialized view', statements: [`REFRESH MATERIALIZED VIEW ${fq(o.schema, o.name)}`], success: `${o.name} refreshed`, confirmLabel: 'Refresh' })}>Refresh data</Button>
          )}
          {isRoutine && <Button size="sm" variant="outline" icon={<Play size={13} />} onClick={() => routineToEditor(connId, db, dbObj, 'call')}>{o.kind === 'procedure' ? 'Call' : 'Execute'}</Button>}
          {isRoutine && <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={() => routineToEditor(connId, db, dbObj, 'edit')}>Edit in SQL editor</Button>}
          {o.kind === 'view' && <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={() => useWorkspace.getState().newQuery({ connId, database: db, sql: o.ddl, title: `Edit ${o.name}` })}>Edit in SQL editor</Button>}
          <DropdownMenu align="end" trigger={<IconButton label="More actions"><Ellipsis size={15} /></IconButton>} items={objectMenu(connId, db, dbObj)} />
        </div>
      </div>
    </div>
  );
}

function DdlView({ ctx }: { ctx: Ctx }) {
  const { o, connId, db } = ctx;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionToolbar title="DDL" description="Generated from the system catalog.">
        <CopyButton text={o.ddl} />
        <Button size="sm" variant="outline" icon={<FileCode2 size={13} />} onClick={() => useWorkspace.getState().newQuery({ connId, database: db, sql: o.ddl, title: `${o.name}.sql` })}>Open in editor</Button>
      </SectionToolbar>
      <CodeView className="min-h-0 flex-1 border-t border-border" value={o.ddl} />
    </div>
  );
}

function ViewDefinition({ ctx }: { ctx: Ctx }) {
  const v = ctx.o as ViewDetails;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionToolbar title="Query" description={v.kind === 'view' ? 'Edit opens CREATE OR REPLACE VIEW in a new editor tab.' : 'The query that populates this materialized view.'}>
        <CopyButton text={v.definition} />
      </SectionToolbar>
      <CodeView className="min-h-0 flex-1 border-t border-border" value={v.definition + ';\n'} />
    </div>
  );
}

function ColumnsList({ cols, title = 'Columns' }: { cols: { name: string; dataType: string; comment: string | null }[]; title?: string }) {
  return (
    <>
      <SectionToolbar title={title} count={cols.length} />
      <DataTable className="min-h-0 flex-1" columns={[
        { key: 'n', header: '#', width: 40, align: 'right', className: 'text-subtle', render: (_c, i) => i + 1 },
        { key: 'name', header: 'Name', render: (c) => <span className="font-medium">{c.name}</span> },
        { key: 'type', header: 'Type', render: (c) => <TypeText type={c.dataType} /> },
        { key: 'comment', header: 'Comment', className: 'text-muted', render: (c) => c.comment },
      ]} rows={cols} rowKey={(c) => c.name} />
    </>
  );
}

function DepTable({ ctx, rows, empty }: { ctx: Ctx; rows: DependencyRef[]; empty: string }) {
  const open = (d: DependencyRef) => (isTableKind(d.kind) ? openStructure(ctx.connId, ctx.db, d.schema, d.name, d.kind) : openObjectByName(ctx.connId, ctx.db, d.schema, d.name, d.kind));
  return (
    <DataTable columns={[
      { key: 'name', header: 'Object', render: (d) => <button className="flex items-center gap-1.5 font-medium text-fg hover:text-accent hover:underline" onClick={() => open(d)}>{objectIcon(d.kind)}{d.schema}.{d.name}</button> },
      { key: 'kind', header: 'Kind', render: (d) => <span className="text-muted">{d.kind.replace(/_/g, ' ')}</span> },
    ]} rows={rows} rowKey={(d) => String(d.oid)} empty={<div className="px-4 pb-4 text-xs text-subtle">{empty}</div>} />
  );
}

function Dependencies({ ctx, v }: { ctx: Ctx; v: ViewDetails }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <SectionToolbar title="Depends on" count={v.dependsOn.length} description="Relations referenced by this view’s query." />
      <DepTable ctx={ctx} rows={v.dependsOn} empty="No dependencies." />
      <SectionToolbar title="Dependents" count={v.dependents.length} description="Views that would need CASCADE to drop this one." />
      <DepTable ctx={ctx} rows={v.dependents} empty="No other view depends on this one." />
    </div>
  );
}

function IndexList({ v }: { v: ViewDetails }) {
  return (
    <>
      <SectionToolbar title="Indexes" count={v.indexes.length} description="A unique index enables REFRESH … CONCURRENTLY." />
      <DataTable className="min-h-0 flex-1" columns={[
        { key: 'n', header: 'Name', render: (i) => <span className="font-medium">{i.name}</span> },
        { key: 'd', header: 'Definition', render: (i) => <Mono className="text-muted">{i.definition}</Mono> },
        { key: 's', header: 'Size', align: 'right', render: (i) => formatBytes(i.sizeBytes) },
      ]} rows={v.indexes} rowKey={(i) => String(i.oid)} empty={<EmptyBlock title="No indexes" />} />
    </>
  );
}

function Grants({ grants, owner }: { grants: GrantDetail[]; owner: string }) {
  const by = new Map<string, string[]>();
  for (const g of grants) by.set(g.grantee, [...(by.get(g.grantee) ?? []), g.privilege + (g.grantable ? '*' : '')]);
  return (
    <>
      <SectionToolbar title="Privileges" count={by.size} description="* = with grant option" />
      <DataTable className="min-h-0 flex-1" columns={[
        { key: 'r', header: 'Role', width: 240, render: ([r]) => <span className="flex items-center gap-1.5 font-medium">{r}{r === owner && <Badge tone="accent">owner</Badge>}</span> },
        { key: 'p', header: 'Privileges', render: ([, ps]) => <span className="flex flex-wrap gap-1">{ps.map((p) => <Badge key={p}>{p}</Badge>)}</span> },
      ]} rows={[...by.entries()]} rowKey={([r]) => r} />
    </>
  );
}

function FunctionDetailsView({ ctx, f }: { ctx: Ctx; f: FunctionDetails }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <Card title="Parameters">
          {f.params.length === 0 ? <div className="text-xs text-subtle">No parameters.</div> : (
            <DataTable className="-m-3.5" columns={[
              { key: 'm', header: 'Mode', width: 90, render: (p) => <Badge tone={p.mode === 'IN' ? 'neutral' : 'accent'}>{p.mode}</Badge> },
              { key: 'n', header: 'Name', render: (p) => <span className="font-medium">{p.name ?? <span className="text-subtle">unnamed</span>}</span> },
              { key: 't', header: 'Type', render: (p) => <TypeText type={p.type} /> },
              { key: 'd', header: 'Default', render: (p) => p.default && <Mono className="text-syntax-string">{p.default}</Mono> },
            ]} rows={f.params} rowKey={(_p, i) => String(i)} />
          )}
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Signature">
            <KeyValue items={[
              ['Kind', KIND_LABEL[f.kind]],
              ['Arguments', f.arguments ? <Mono>{f.arguments}</Mono> : <span className="text-subtle">none</span>],
              ...(f.kind !== 'procedure' ? [['Returns', f.result ? <TypeText type={f.result} /> : null] as [ReactNode, ReactNode]] : []),
              ['Language', f.language],
              ['Owner', f.owner],
            ]} />
          </Card>
          <Card title="Behavior">
            <KeyValue items={[
              ['Volatility', <Badge tone={f.volatility === 'volatile' ? 'warning' : 'success'}>{f.volatility}</Badge>],
              ['Strict', f.strict ? 'yes — returns NULL on NULL input' : 'no'],
              ['Security', f.securityDefiner ? <Badge tone="danger">security definer</Badge> : 'invoker'],
              ['Parallel', f.parallel],
              ['Leakproof', f.leakproof ? 'yes' : 'no'],
              ['Cost', f.rows != null ? `${f.cost} · ${f.rows} rows` : f.cost],
              ...(f.config.length ? [['Settings', <Mono>{f.config.join(', ')}</Mono>] as [ReactNode, ReactNode]] : []),
            ]} />
          </Card>
        </div>
        {f.usedByTriggers.length > 0 && (
          <Card title="Used by triggers">
            <div className="flex flex-col gap-1.5 text-[12.5px]">
              {f.usedByTriggers.map((t) => (
                <button key={`${t.schema}.${t.table}.${t.trigger}`} className="flex items-center gap-2 text-left hover:text-accent" onClick={() => openStructure(ctx.connId, ctx.db, t.schema, t.table, undefined, 'triggers')}>
                  {objectIcon('trigger')} <span className="font-medium">{t.trigger}</span> <span className="text-subtle">on</span> {t.schema}.{t.table}
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function SequenceView({ ctx, s }: { ctx: Ctx; s: SequenceDetails }) {
  const { connId, db } = ctx;
  const ref = fq(s.schema, s.name);
  const cur = s.lastValue != null ? Number(s.lastValue) : null;
  const max = Number(s.max);
  const min = Number(s.min);
  const used = cur != null && s.isCalled ? Math.min(1, Math.max(0, (cur - min) / (max - min))) : 0;
  const setval = async () => {
    const v = await prompt({ title: 'Set current value', message: <>Next <Mono>nextval()</Mono> returns this value + increment.</>, defaultValue: s.lastValue ?? s.start, confirmLabel: 'Continue' });
    if (v == null || !/^-?\d+$/.test(v.trim())) return;
    await runDdl({ connId, db, title: 'Set sequence value', statements: [`SELECT setval(${lit(ref)}, ${v.trim()}, true)`], success: `${s.name} set to ${v.trim()}`, confirmLabel: 'Set value', danger: true });
  };
  const restart = async () => {
    const v = await prompt({ title: 'Restart sequence', message: 'The next value returned will be:', defaultValue: s.start, confirmLabel: 'Continue' });
    if (v == null || !/^-?\d+$/.test(v.trim())) return;
    await runDdl({ connId, db, title: 'Restart sequence', statements: [`ALTER SEQUENCE ${ref} RESTART WITH ${v.trim()}`], success: `${s.name} restarted`, confirmLabel: 'Restart', danger: true });
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Current value" value={s.isCalled ? Number(s.lastValue).toLocaleString() : '—'} sub={s.isCalled ? 'last value handed out' : 'nextval() not called yet'} />
          <StatCard label="Increment" value={s.increment} sub={`cache ${s.cache}`} />
          <StatCard label="Range used" value={`${(used * 100).toFixed(used < 0.01 ? 4 : 1)}%`} sub={`of ${s.dataType}`} tone={used > 0.8 ? 'danger' : used > 0.5 ? 'warning' : undefined} />
          <StatCard label="Cycle" value={s.cycle ? 'yes' : 'no'} sub={s.cycle ? 'wraps around at max' : 'errors at max'} />
        </div>
        <Card title="Settings" actions={
          <div className="flex gap-1">
            <Button size="xs" variant="outline" onClick={setval}>Set value…</Button>
            <Button size="xs" variant="outline" onClick={restart}>Restart…</Button>
          </div>
        }>
          <KeyValue items={[
            ['Data type', <TypeText type={s.dataType} />],
            ['Start', <Mono>{s.start}</Mono>],
            ['Minimum', <Mono>{s.min}</Mono>],
            ['Maximum', <Mono>{s.max}</Mono>],
            ['Owned by', s.ownedBy ? (
              <button className="inline-flex items-center gap-1 text-info hover:underline" onClick={() => openStructure(connId, db, s.ownedBy!.schema, s.ownedBy!.table)}>
                {s.ownedBy.schema}.{s.ownedBy.table}.{s.ownedBy.column} {s.identity && <Badge tone="accent">identity</Badge>}
              </button>
            ) : <span className="text-subtle">none (standalone)</span>],
            ['Owner', s.owner],
          ]} />
        </Card>
      </div>
    </div>
  );
}

function EnumValues({ ctx, e }: { ctx: Ctx; e: EnumDetails }) {
  const { connId, db } = ctx;
  const ref = fq(e.schema, e.name);
  const [pos, setPos] = useState<string>('');
  const add = async () => {
    const v = await prompt({ title: `Add value to ${e.name}`, placeholder: 'new_value', confirmLabel: 'Continue' });
    if (!v?.trim()) return;
    const where = pos ? ` ${pos.startsWith('<') ? 'BEFORE' : 'AFTER'} ${lit(pos.slice(1))}` : '';
    await runDdl({ connId, db, title: 'Add enum value', message: 'Enum values cannot be removed once added.', statements: [`ALTER TYPE ${ref} ADD VALUE IF NOT EXISTS ${lit(v.trim())}${where}`], success: `Added '${v.trim()}'`, confirmLabel: 'Add value', transaction: false });
  };
  const rename = async (old: string) => {
    const v = await prompt({ title: 'Rename value', defaultValue: old, confirmLabel: 'Rename' });
    if (!v?.trim() || v === old) return;
    await runDdl({ connId, db, title: 'Rename enum value', message: 'Existing rows using this value are renamed too.', statements: [`ALTER TYPE ${ref} RENAME VALUE ${lit(old)} TO ${lit(v.trim())}`], success: `Renamed '${old}' to '${v.trim()}'`, confirmLabel: 'Rename' });
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <SectionToolbar title="Values" count={e.values.length} description="In sort order — comparisons and ORDER BY follow this order.">
        <select value={pos} onChange={(ev) => setPos(ev.target.value)} className="h-7 rounded-md border border-border-strong bg-bg px-2 text-xs text-fg outline-none">
          <option value="">at the end</option>
          {e.values.map((v) => <option key={'<' + v} value={'<' + v}>before {v}</option>)}
          {e.values.map((v) => <option key={'>' + v} value={'>' + v}>after {v}</option>)}
        </select>
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={add}>Add value</Button>
      </SectionToolbar>
      <div className="flex flex-col gap-1 px-4 pb-4">
        {e.values.map((v, i) => (
          <div key={v} className="group flex h-9 max-w-xl items-center gap-3 rounded-md border border-border bg-panel px-3">
            <GripVertical size={13} className="text-border-strong" />
            <span className="w-6 text-right text-[11px] text-subtle tabular-nums">{i + 1}</span>
            <span className="flex-1 font-mono text-[12.5px] text-syntax-string">'{v}'</span>
            <IconButton label="Rename value" size="xs" className="opacity-0 group-hover:opacity-100" onClick={() => rename(v)}><Pencil size={12} /></IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}

function Usage({ ctx, usage }: { ctx: Ctx; usage: TypeUsage[] }) {
  return (
    <>
      <SectionToolbar title="Used by" count={usage.length} description="Columns whose type is this type (or an array of it)." />
      <DataTable className="min-h-0 flex-1" columns={[
        {
          key: 't', header: 'Relation', render: (u) => (
            <button className="flex items-center gap-1.5 font-medium hover:text-accent hover:underline"
              onClick={() => (isTableKind(u.kind) ? openStructure(ctx.connId, ctx.db, u.schema, u.table, u.kind) : openObjectByName(ctx.connId, ctx.db, u.schema, u.table, u.kind))}>
              {objectIcon(u.kind)} {u.schema}.{u.table}
            </button>
          ),
        },
        { key: 'c', header: 'Column', render: (u) => <Mono>{u.column}</Mono> },
        { key: 'k', header: 'Kind', render: (u) => <span className="text-muted">{u.kind.replace(/_/g, ' ')}</span> },
      ]} rows={usage} rowKey={(u) => `${u.schema}.${u.table}.${u.column}`} empty={<EmptyBlock title="Not used" description="No table or view column uses this type." />} />
    </>
  );
}

function DomainView({ ctx, d }: { ctx: Ctx; d: DomainDetails }) {
  const { connId, db } = ctx;
  const ref = fq(d.schema, d.name);
  const addCheck = async () => {
    const expr = await prompt({ title: 'Add check constraint', message: <>Use <Mono>VALUE</Mono> to refer to the value, e.g. <Mono>VALUE &gt; 0</Mono></>, placeholder: 'VALUE …', confirmLabel: 'Continue' });
    if (!expr?.trim()) return;
    await runDdl({ connId, db, title: 'Add domain constraint', statements: [`ALTER DOMAIN ${ref} ADD CHECK (${expr.trim()})`], success: 'Constraint added', confirmLabel: 'Add' });
  };
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <Card title="Definition">
          <KeyValue items={[
            ['Base type', <TypeText type={d.baseType} />],
            ['Not null', d.notNull ? <Badge tone="warning">NOT NULL</Badge> : 'no'],
            ['Default', d.default ? <Mono className="text-syntax-string">{d.default}</Mono> : null],
            ['Collation', d.collation],
            ['Owner', d.owner],
          ]} />
        </Card>
        <Card title="Check constraints" actions={<Button size="xs" variant="outline" icon={<Plus size={12} />} onClick={addCheck}>Add check</Button>}>
          {d.constraints.length === 0 ? <div className="text-xs text-subtle">No check constraints.</div> : (
            <div className="flex flex-col gap-2">
              {d.constraints.map((c) => (
                <div key={c.name} className="group flex items-center gap-3 rounded-md bg-sunken px-3 py-2">
                  <span className="text-[12.5px] font-medium">{c.name}</span>
                  <ArrowRight size={12} className="text-subtle" />
                  <Mono className="flex-1 text-muted">{c.definition}</Mono>
                  {!c.validated && <Badge tone="warning">not valid</Badge>}
                  <IconButton label="Drop constraint" size="xs" className="opacity-0 group-hover:opacity-100 hover:text-danger"
                    onClick={() => runDdl({ connId, db, title: `Drop ${c.name}?`, danger: true, confirmLabel: 'Drop', statements: [`ALTER DOMAIN ${ref} DROP CONSTRAINT ${qi(c.name)}`], success: `Dropped ${c.name}` })}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}


