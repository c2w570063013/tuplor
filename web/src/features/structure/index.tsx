import { ChevronRight, Ellipsis, Pencil, RefreshCw, Table2, TableProperties } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TableDetails } from '@shared/schema';
import { Badge, Button, DropdownMenu, IconButton, Kbd, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, modKey } from '@/lib/format';
import { useWorkspace } from '@/stores/workspace';
import { objectMenu, openData, openStructure } from '../explorer/actions';
import { objectIcon } from '../explorer/ExplorerTree';
import type { TabProps } from '../common/TabProps';
import { runDdl, useTableDetails, useTypeSuggestions } from './api';
import { ColumnsEditor, ColumnsView } from './sections/Columns';
import { ConstraintsSection, ForeignKeysSection } from './sections/Constraints';
import { IndexesSection } from './sections/Indexes';
import { DdlSection, PartitionsSection, PermissionsSection, StatsSection, TriggersSection } from './sections/Other';
import { columnChanges, draftFromColumn, type ColumnDraft } from './sqlgen';
import { CellInput, ErrorState, Loading } from './ui';

type Section = 'columns' | 'indexes' | 'constraints' | 'foreign-keys' | 'triggers' | 'partitions' | 'stats' | 'permissions' | 'ddl';

function sectionsFor(t: TableDetails): { id: Section; label: string; count?: ReactNode }[] {
  const isTable = t.kind === 'table' || t.kind === 'partitioned_table' || t.kind === 'foreign_table';
  const list: { id: Section; label: string; count?: ReactNode; show: boolean }[] = [
    { id: 'columns', label: 'Columns', count: t.columns.length, show: true },
    { id: 'indexes', label: 'Indexes', count: t.indexes.length, show: isTable || t.kind === 'materialized_view' },
    { id: 'constraints', label: 'Constraints', count: t.constraints.length, show: isTable },
    { id: 'foreign-keys', label: 'Foreign keys', count: t.foreignKeys.length + t.referencedBy.length, show: isTable },
    { id: 'triggers', label: 'Triggers', count: t.triggers.length, show: isTable || t.kind === 'view' },
    { id: 'partitions', label: 'Partitions', count: t.partitions.length, show: t.kind === 'partitioned_table' || !!t.partitionOf },
    { id: 'stats', label: 'Storage & Stats', show: t.kind !== 'view' },
    { id: 'permissions', label: 'Permissions', show: true },
    { id: 'ddl', label: 'DDL', show: true },
  ];
  return list.filter((s) => s.show);
}

/** Table structure tab (kind "structure"; params { schema, table, objectKind?, section? }). */
export default function StructureTab({ tab, active }: TabProps) {
  const { schema, table } = tab.params as { schema: string; table: string };
  const connId = tab.connId!;
  const db = tab.database!;
  const q = useTableDetails(connId, db, schema, table);
  const t = q.data;
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<ColumnDraft[]>([]);
  const [comment, setComment] = useState('');
  const [applying, setApplying] = useState(false);
  const types = useTypeSuggestions(connId, db);

  const sections = t ? sectionsFor(t) : [];
  const requested = (tab.params.section as Section) ?? 'columns';
  const section = sections.some((s) => s.id === requested) ? requested : 'columns';
  const setSection = (s: Section) => useWorkspace.getState().updateParams(tab.id, { section: s });

  const pending = useMemo(
    () => (editing && t ? columnChanges(schema, table, drafts, { from: t.comment, to: comment }) : []),
    [editing, t, schema, table, drafts, comment],
  );

  useEffect(() => {
    useWorkspace.getState().updateTab(tab.id, { dirty: pending.length > 0 });
  }, [pending.length, tab.id]);

  const startEdit = () => {
    if (!t) return;
    setDrafts(t.columns.map(draftFromColumn));
    setComment(t.comment ?? '');
    setEditing(true);
    setSection('columns');
  };
  const discard = () => {
    setEditing(false);
    setDrafts([]);
  };
  const apply = async () => {
    if (!pending.length) return;
    setApplying(true);
    const ok = await runDdl({
      connId, db,
      title: `Apply ${pending.length} change${pending.length > 1 ? 's' : ''} to ${schema}.${table}`,
      message: 'All statements run in a single transaction — if one fails, nothing is changed.',
      statements: pending,
      danger: drafts.some((d) => d.drop),
      confirmLabel: 'Apply changes',
      success: `${table}: ${pending.length} change${pending.length > 1 ? 's' : ''} applied`,
    });
    setApplying(false);
    if (ok) discard();
  };

  // ⌘S applies pending changes, Esc leaves edit mode when nothing changed
  useEffect(() => {
    if (!active || !editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (q.isLoading) return <Loading label={`Loading ${schema}.${table}…`} />;
  if (q.error || !t) return <ErrorState error={q.error ?? new Error('Not found')} onRetry={() => q.refetch()} />;

  const obj = { oid: t.oid, schema: t.schema, name: t.name, kind: t.kind };
  const kindLabel = t.kind === 'partitioned_table' ? 'partitioned table' : t.kind.replace(/_/g, ' ');

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="shrink-0 border-b border-border bg-bg px-5 pt-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft [&_svg]:h-[18px] [&_svg]:w-[18px]">{objectIcon(t.kind)}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-[11.5px] text-subtle">
              <span>{db}</span><ChevronRight size={11} /><span>{t.schema}</span>
              {t.partitionOf && (
                <>
                  <ChevronRight size={11} />
                  <button className="hover:text-accent hover:underline" onClick={() => openStructure(connId, db, t.partitionOf!.schema, t.partitionOf!.name)}>{t.partitionOf.name}</button>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[17px] font-semibold text-fg">{t.name}</h1>
              <Badge>{kindLabel}</Badge>
              {t.persistence === 'u' && <Badge tone="warning">unlogged</Badge>}
              {t.rlsEnabled && <Badge tone="accent">RLS</Badge>}
              {t.partitionOf && <Badge tone="accent">partition</Badge>}
              {q.isFetching && <Spinner size={12} className="text-subtle" />}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-muted">
              {t.kind !== 'view' && <span>{formatCount(t.stats.estRows)} rows</span>}
              {t.kind !== 'view' && <span>{formatBytes(t.stats.totalBytes)}</span>}
              <span>owner {t.owner}</span>
              {t.partitionKey && <span>partitioned by <span className="font-mono text-fg">{t.partitionKey}</span></span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton label="Refresh" onClick={() => q.refetch()}><RefreshCw size={14} /></IconButton>
            <Button size="sm" variant="outline" icon={<Table2 size={13} />} onClick={() => openData(connId, db, obj)}>Data</Button>
            {(t.kind === 'table' || t.kind === 'partitioned_table') && !editing && (
              <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={startEdit}>Edit</Button>
            )}
            <DropdownMenu align="end" trigger={<IconButton label="More actions"><Ellipsis size={15} /></IconButton>} items={objectMenu(connId, db, obj)} />
          </div>
        </div>
        {/* comment */}
        <div className="mt-2 ml-12 max-w-3xl">
          {editing ? (
            <CellInput value={comment} onChange={setComment} placeholder="Add a table comment…" changed={comment.trim() !== (t.comment ?? '').trim()} className="-ml-2 text-[12.5px]" />
          ) : t.comment ? (
            <p className="text-[12.5px] text-muted">{t.comment}</p>
          ) : null}
        </div>
        {/* section nav */}
        <nav className="mt-2 -mb-px flex gap-0.5 overflow-x-auto" role="tablist">
          {sections.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={section === s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[12.5px] font-medium transition-colors',
                section === s.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {s.label}
              {s.count != null && <span className={cn('rounded-full px-1.5 text-[10.5px] tabular-nums', section === s.id ? 'bg-accent-soft text-accent' : 'bg-active text-subtle')}>{s.count}</span>}
            </button>
          ))}
        </nav>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col">
        {section === 'columns' && (editing
          ? <ColumnsEditor drafts={drafts} setDrafts={setDrafts} types={types.data ?? []} />
          : <div className="flex min-h-0 flex-1 flex-col" onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('tbody') && (t.kind === 'table' || t.kind === 'partitioned_table')) startEdit(); }}><ColumnsView t={t} connId={connId} db={db} /></div>)}
        {section === 'indexes' && <IndexesSection t={t} connId={connId} db={db} />}
        {section === 'constraints' && <ConstraintsSection t={t} connId={connId} db={db} />}
        {section === 'foreign-keys' && <ForeignKeysSection t={t} connId={connId} db={db} />}
        {section === 'triggers' && <TriggersSection t={t} connId={connId} db={db} />}
        {section === 'partitions' && <PartitionsSection t={t} connId={connId} db={db} />}
        {section === 'stats' && <StatsSection t={t} connId={connId} db={db} />}
        {section === 'permissions' && <PermissionsSection t={t} connId={connId} db={db} />}
        {section === 'ddl' && <DdlSection t={t} connId={connId} db={db} />}
      </div>

      {/* pending changes bar */}
      {editing && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border bg-panel px-4">
          <TableProperties size={15} className="text-accent" />
          <span className="text-[12.5px] text-fg">
            {pending.length ? <><span className="font-semibold">{pending.length}</span> pending change{pending.length > 1 ? 's' : ''}</> : <span className="text-muted">Editing — no changes yet</span>}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" onClick={discard}>{pending.length ? 'Discard' : 'Done'}</Button>
          <Button variant="primary" disabled={!pending.length} loading={applying} onClick={apply}>
            Review & apply <Kbd className="ml-1 border-white/30 bg-white/15 text-white">{modKey}S</Kbd>
          </Button>
        </div>
      )}
    </div>
  );
}
