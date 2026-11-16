import * as Popover from '@radix-ui/react-popover';
import { Columns3, GripVertical, KeyRound, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { TableColumn } from '@shared/tableData';
import { Button, Checkbox, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { shortType } from './api';

/** Column visibility & order popover. `order` = visible data column indexes in display order. */
export function ColumnsMenu({
  columns, order, onChange, trigger,
}: { columns: TableColumn[]; order: number[]; onChange: (order: number[]) => void; trigger: ReactNode }) {
  const [q, setQ] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const visible = new Set(order);
  // visible columns in display order, then hidden ones in table order
  const list = [...order, ...columns.map((_, i) => i).filter((i) => !visible.has(i))];
  const shown = q ? list.filter((i) => columns[i].name.toLowerCase().includes(q.toLowerCase())) : list;

  const toggle = (i: number, on: boolean) => {
    if (on) {
      // re-insert near its table position
      const next = [...order];
      const pos = next.findIndex((j) => j > i);
      next.splice(pos < 0 ? next.length : pos, 0, i);
      onChange(next);
    } else if (order.length > 1) onChange(order.filter((j) => j !== i));
  };
  const drop = (target: number) => {
    if (dragFrom === null || dragFrom === target || !visible.has(target)) return;
    const next = order.filter((j) => j !== dragFrom);
    const at = next.indexOf(target);
    next.splice(order.indexOf(dragFrom) < order.indexOf(target) ? at + 1 : at, 0, dragFrom);
    onChange(next);
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="animate-pop-in z-[90] flex w-72 flex-col rounded-lg border border-border bg-elevated shadow-pop outline-none"
        >
          <div className="flex items-center gap-2 border-b border-border p-2">
            <Input size="sm" icon={<Search size={12} />} className="flex-1" placeholder="Find column…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <div className="max-h-[360px] overflow-auto p-1">
            {shown.map((i) => {
              const c = columns[i];
              const on = visible.has(i);
              return (
                <div
                  key={i}
                  draggable={on && !q}
                  onDragStart={() => setDragFrom(i)}
                  onDragEnd={() => setDragFrom(null)}
                  onDragOver={(e) => { if (on && dragFrom !== null) e.preventDefault(); }}
                  onDrop={() => drop(i)}
                  className={cn('group flex h-7 items-center gap-2 rounded-md px-1.5 text-[12.5px] hover:bg-hover', dragFrom === i && 'opacity-40')}
                >
                  <GripVertical size={12} className={cn('shrink-0 text-subtle', on && !q ? 'cursor-grab opacity-0 group-hover:opacity-100' : 'opacity-0')} />
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <Checkbox checked={on} onCheckedChange={(v) => toggle(i, v)} disabled={on && order.length === 1} />
                    {c.isPrimaryKey && <KeyRound size={11} className="shrink-0 text-warning" />}
                    <span className={cn('truncate', !on && 'text-muted')}>{c.name}</span>
                    <span className="ml-auto shrink-0 truncate text-[10.5px] text-subtle">{shortType(c)}</span>
                  </label>
                </div>
              );
            })}
            {!shown.length && <div className="p-3 text-center text-xs text-subtle">No columns match</div>}
          </div>
          <div className="flex items-center gap-1 border-t border-border p-2">
            <span className="mr-auto text-[11px] text-subtle">{order.length} of {columns.length} shown</span>
            <Button size="xs" variant="ghost" onClick={() => onChange([order[0] ?? 0])}>Hide all</Button>
            <Button size="xs" variant="ghost" onClick={() => onChange(columns.map((_, i) => i))}>Show all</Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const ColumnsIcon = Columns3;
