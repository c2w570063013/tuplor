import { createContext, memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Copy, Eye, Focus, KeyRound, Layers, Link2, Table2, TableProperties, Columns3, Fingerprint } from 'lucide-react';
import { ContextMenu } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, quoteIdent } from '@/lib/format';
import { HEADER_H, PAD_Y, ROW_H, type TableNode as TableNodeType } from './model';
import { useErdUi } from './uiStore';
import type { ErdColumn, ErdTable } from '@shared/erd';

export interface ErdActions {
  openData: (t: ErdTable) => void;
  openStructure: (t: ErdTable) => void;
  focusTable: (id: string) => void;
}
export const ErdActionsContext = createContext<ErdActions | null>(null);

const KIND_ICON = {
  table: Table2,
  partitioned_table: Layers,
  view: Eye,
  materialized_view: Eye,
  foreign_table: Table2,
};
const KIND_LABEL: Record<string, string> = {
  table: 'table',
  partitioned_table: 'partitioned table',
  view: 'view',
  materialized_view: 'materialized view',
  foreign_table: 'foreign table',
};

const hidden = { opacity: 0, pointerEvents: 'none' as const, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

function TableNodeImpl({ id, data }: NodeProps<TableNodeType>) {
  const { table, rows, color, width, height } = data;
  const hi = useErdUi((s) => (s.active ? (s.active.nodes.has(id) ? 1 : 0) : 2));
  const primary = useErdUi((s) => s.primary.has(id));
  // Only this table's hot columns, as a string so unrelated hovers don't re-render us.
  const hot = useErdUi((s) => {
    if (!s.hotColumns.size) return '';
    let out = '';
    for (const k of s.hotColumns) if (k.startsWith(id + '\u0000')) out += k.slice(id.length + 1) + '\u0001';
    return out;
  });
  const actions = useContext(ErdActionsContext)!;
  const Icon = KIND_ICON[table.kind] ?? Table2;
  const isView = table.kind === 'view' || table.kind === 'materialized_view';

  return (
    <ContextMenu
      items={[
        { label: isView ? 'Open data' : 'Open table data', icon: <Table2 size={14} />, onSelect: () => actions.openData(table) },
        { label: 'Open structure', icon: <TableProperties size={14} />, onSelect: () => actions.openStructure(table) },
        { label: 'Focus relations', icon: <Focus size={14} />, onSelect: () => actions.focusTable(id) },
        'separator',
        { label: 'Copy name', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(`${table.schema}.${table.name}`) },
        { label: 'Copy SELECT', icon: <Copy size={14} />, onSelect: () => navigator.clipboard.writeText(`SELECT * FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)} LIMIT 100;`) },
      ]}
    >
      <div
        className={cn(
          'erd-node flex flex-col overflow-hidden rounded-lg border bg-elevated text-fg transition-[opacity,box-shadow,border-color] duration-150',
          hi === 0 ? 'opacity-25' : 'opacity-100',
          primary ? 'border-accent shadow-[0_0_0_3px_var(--accent-soft),var(--shadow)]' : hi === 1 ? 'border-border-strong shadow-pop' : 'border-border shadow-sm',
        )}
        style={{ width, height }}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
        <Handle type="source" position={Position.Right} isConnectable={false} style={hidden} />
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border px-2.5"
          style={{
            height: HEADER_H,
            borderTop: `3px solid ${color}`,
            background: `color-mix(in srgb, ${color} 9%, var(--elevated))`,
          }}
        >
          <Icon size={14} style={{ color }} className="shrink-0" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className={cn('truncate text-[12.5px] font-semibold', isView && 'italic')} title={table.comment ?? undefined}>
              {table.name}
            </div>
            <div className="truncate text-[10px] text-subtle">
              {table.schema}
              {table.kind !== 'table' && <> · {KIND_LABEL[table.kind]}</>}
            </div>
          </div>
          {table.estRows != null && (
            <span className="shrink-0 rounded bg-active px-1.5 text-[10px] font-medium text-muted tabular-nums" title={`≈ ${table.estRows.toLocaleString()} rows`}>
              {formatCount(table.estRows)}
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <div style={{ paddingTop: PAD_Y, paddingBottom: PAD_Y }}>
            {rows.map((c) => (
              <ColumnRow key={c.name} col={c} hot={hot.includes(c.name + '\u0001')} />
            ))}
            {data.hidden > 0 && (
              <div className="flex items-center px-2.5 text-[11px] text-subtle italic" style={{ height: ROW_H }}>
                + {data.hidden} more columns
              </div>
            )}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}

function ColumnRow({ col, hot }: { col: ErdColumn; hot: boolean }) {
  const icon = col.pk ? (
    <KeyRound size={11} className="text-warning" />
  ) : col.fk ? (
    <Link2 size={11} className="text-accent" />
  ) : col.unique ? (
    <Fingerprint size={11} className="text-info" />
  ) : (
    <Columns3 size={11} className="text-subtle opacity-50" />
  );
  const tip = [
    `${col.name} ${col.type}${col.nullable ? '' : ' NOT NULL'}`,
    col.pk && 'Primary key',
    col.fk && 'Foreign key',
    col.unique && !col.pk && 'Unique',
    col.default && `Default: ${col.default}`,
    col.comment,
  ].filter(Boolean).join('\n');
  return (
    <div
      className={cn('flex items-center gap-1.5 px-2.5 text-[12px]', hot && 'bg-accent-soft')}
      style={{ height: ROW_H }}
      title={tip}
    >
      <span className="flex w-3.5 shrink-0 justify-center">{icon}</span>
      <span className={cn('min-w-0 shrink truncate', col.pk ? 'font-semibold' : col.nullable ? 'text-muted' : 'font-medium', hot && 'text-accent')}>
        {col.name}
      </span>
      <span className="ml-auto min-w-0 shrink truncate pl-3 font-mono text-[10.5px] text-subtle">
        {col.type}
        {col.nullable && <span className="opacity-60">?</span>}
      </span>
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);
