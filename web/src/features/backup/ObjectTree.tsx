import { useMemo, useState } from 'react';
import { ChevronRight, DatabaseZap, Eye, Folder, Hash, Layers, Search, Table2 } from 'lucide-react';
import type { BackupTreeSchema } from '@shared/backup';
import { Checkbox, Input, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';

const KIND_ICON = { table: Table2, partitioned_table: Layers, view: Eye, materialized_view: Eye, foreign_table: Table2, sequence: Hash };
const HAS_DATA = new Set(['table', 'partitioned_table', 'materialized_view']);

/**
 * Checklist tree of schemas → tables.
 *  - mode "schemas": schema checkboxes
 *  - mode "tables": tri-state schema checkboxes + table checkboxes
 *  - any mode: per-table "skip data" toggle (→ --exclude-table-data)
 */
export function ObjectTree({
  tree, mode, schemas, tables, noData, onSchemas, onTables, onNoData,
}: {
  tree: BackupTreeSchema[];
  mode: 'database' | 'schemas' | 'tables';
  schemas: Set<string>;
  tables: Set<string>;
  noData: Set<string>;
  onSchemas: (s: Set<string>) => void;
  onTables: (s: Set<string>) => void;
  onNoData: (s: Set<string>) => void;
}) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.length === 1 ? [tree[0].name] : []));
  const f = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      tree
        .map((s) => ({ ...s, tables: f ? s.tables.filter((t) => t.name.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)) : s.tables }))
        .filter((s) => !f || s.tables.length || s.name.toLowerCase().includes(f)),
    [tree, f],
  );

  const toggleSet = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border bg-bg">
      <div className="border-b border-border p-1.5">
        <Input size="sm" icon={<Search size={12} />} placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="max-h-72 min-h-24 overflow-auto py-1">
        {visible.map((s) => {
          const isOpen = !!f || open.has(s.name);
          const ids = s.tables.map((t) => `${s.name}.${t.name}`);
          const nSel = ids.filter((id) => tables.has(id)).length;
          const schemaChecked: boolean | 'indeterminate' =
            mode === 'schemas' ? schemas.has(s.name) : nSel === 0 ? false : nSel === ids.length ? true : 'indeterminate';
          return (
            <div key={s.name}>
              <div className="group flex h-7 items-center gap-1.5 px-1.5 hover:bg-hover">
                <button
                  className="flex h-5 w-5 items-center justify-center rounded text-subtle hover:text-fg"
                  onClick={() => setOpen(toggleSet(open, s.name, !open.has(s.name)))}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                >
                  <ChevronRight size={13} className={cn('transition-transform', isOpen && 'rotate-90')} />
                </button>
                {mode !== 'database' && (
                  <Checkbox
                    checked={schemaChecked}
                    disabled={mode === 'tables' && !ids.length}
                    onCheckedChange={(v) => {
                      if (mode === 'schemas') onSchemas(toggleSet(schemas, s.name, v));
                      else {
                        const next = new Set(tables);
                        for (const id of ids) {
                          if (v && schemaChecked !== true) next.add(id);
                          else next.delete(id);
                        }
                        onTables(next);
                      }
                    }}
                  />
                )}
                <Folder size={13} className="text-subtle" />
                <span className="flex-1 truncate text-[12.5px] font-medium">{s.name}</span>
                <span className="pr-1 text-[11px] text-subtle tabular-nums">{s.tables.length}</span>
              </div>
              {isOpen &&
                s.tables.map((t) => {
                  const id = `${s.name}.${t.name}`;
                  const Icon = KIND_ICON[t.kind] ?? Table2;
                  const skip = noData.has(id);
                  const dimmed = mode === 'schemas' && !schemas.has(s.name);
                  return (
                    <div key={id} className={cn('group flex h-6.5 items-center gap-1.5 pr-1.5 pl-8 hover:bg-hover', dimmed && 'opacity-50')}>
                      {mode === 'tables' && <Checkbox checked={tables.has(id)} onCheckedChange={(v) => onTables(toggleSet(tables, id, v))} />}
                      <Icon size={12} className="shrink-0 text-subtle" />
                      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', skip && 'text-muted')}>{t.name}</span>
                      {skip && <span className="rounded bg-warning-soft px-1 text-[10px] font-medium text-warning">no data</span>}
                      <span className="text-[10.5px] text-subtle tabular-nums">
                        {t.estRows != null && formatCount(t.estRows)}
                        {t.sizeBytes != null && <span className="ml-2">{formatBytes(t.sizeBytes)}</span>}
                      </span>
                      {HAS_DATA.has(t.kind) && (
                        <Tooltip content={skip ? 'Include data' : 'Skip data (structure only)'}>
                          <button
                            onClick={() => onNoData(toggleSet(noData, id, !skip))}
                            className={cn(
                              'flex h-5 w-5 items-center justify-center rounded hover:bg-active',
                              skip ? 'text-warning' : 'text-subtle opacity-0 group-hover:opacity-100',
                            )}
                            aria-label="Toggle data"
                          >
                            <DatabaseZap size={12} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
        {!visible.length && <div className="px-3 py-4 text-center text-xs text-muted">No matching objects</div>}
      </div>
    </div>
  );
}
