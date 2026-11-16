import { Plus, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { FilterCondition, FilterOp, TableColumn } from '@shared/tableData';
import { Button, Checkbox, IconButton, Input, Segmented, Select } from '@/components/ui';
import { cn } from '@/lib/cn';

export const OPS: { value: FilterOp; label: string }[] = [
  { value: '=', label: '=' },
  { value: '<>', label: '≠' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: 'ILIKE', label: 'ILIKE (contains, any case)' },
  { value: 'LIKE', label: 'LIKE' },
  { value: 'NOT ILIKE', label: 'NOT ILIKE' },
  { value: 'NOT LIKE', label: 'NOT LIKE' },
  { value: 'IN', label: 'IN (list)' },
  { value: 'NOT IN', label: 'NOT IN (list)' },
  { value: 'BETWEEN', label: 'BETWEEN' },
  { value: 'IS NULL', label: 'IS NULL' },
  { value: 'IS NOT NULL', label: 'IS NOT NULL' },
];

export type FilterMode = 'builder' | 'sql';

export interface FilterDraft {
  mode: FilterMode;
  conditions: FilterCondition[];
  where: string;
}

/** Applied filter conditions (empty IN lists / incomplete rows are dropped). */
export function cleanConditions(conds: FilterCondition[]): FilterCondition[] {
  return conds.filter((c) => c.column && c.enabled !== false).map((c) => {
    if (c.op === 'IN' || c.op === 'NOT IN') {
      const values = (c.values ?? splitList(c.value ?? '')).map((v) => v.trim()).filter((v) => v !== '');
      return { column: c.column, op: c.op, values };
    }
    if (c.op === 'BETWEEN') return { column: c.column, op: c.op, values: [c.values?.[0] ?? '', c.values?.[1] ?? ''] };
    if (c.op === 'IS NULL' || c.op === 'IS NOT NULL') return { column: c.column, op: c.op };
    return { column: c.column, op: c.op, value: c.value ?? '' };
  });
}

/** Split "a, b, 'c,d'" into values (quotes allow commas). */
export function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim()).filter((v) => v !== '');
}

export function FilterBar({
  columns, draft, onChange, onApply, onClear, dirty,
}: {
  columns: TableColumn[];
  draft: FilterDraft;
  onChange: (d: FilterDraft) => void;
  onApply: () => void;
  onClear: () => void;
  dirty: boolean;
}) {
  const whereRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (draft.mode === 'sql') whereRef.current?.focus(); }, [draft.mode]);

  const setCond = (i: number, patch: Partial<FilterCondition>) =>
    onChange({ ...draft, conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const add = () => onChange({ ...draft, conditions: [...draft.conditions, { column: columns[0]?.name ?? '', op: '=', value: '' }] });
  const remove = (i: number) => onChange({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onApply(); }
  };
  const colOptions = columns.map((c) => ({ value: c.name, label: c.name }));

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-panel px-2 py-2">
      <div className="flex items-start gap-2">
        <Segmented
          size="xs"
          value={draft.mode}
          onChange={(mode) => onChange({ ...draft, mode })}
          options={[{ value: 'builder', label: 'Builder' }, { value: 'sql', label: 'SQL' }]}
        />
        {draft.mode === 'sql' ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-syntax-keyword">WHERE</span>
            <Input
              ref={whereRef}
              size="sm"
              mono
              className="flex-1"
              placeholder="e.g. status = 'paid' AND total > 100"
              value={draft.where}
              onChange={(e) => onChange({ ...draft, where: e.target.value })}
              onKeyDown={onKey}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {draft.conditions.map((c, i) => {
              const col = columns.find((x) => x.name === c.column);
              const noValue = c.op === 'IS NULL' || c.op === 'IS NOT NULL';
              const enumVals = col?.enumValues && !col.isArray ? col.enumValues : col?.udtName === 'bool' ? ['true', 'false'] : null;
              const valueInput = (val: string, set: (v: string) => void, ph = 'value', cls = 'w-56') =>
                enumVals && (c.op === '=' || c.op === '<>') ? (
                  <Select size="sm" className={cls} value={val} onChange={(e) => set(e.target.value)} options={[{ value: '', label: '— choose —' }, ...enumVals.map((v) => ({ value: v, label: v }))]} />
                ) : (
                  <Input size="sm" className={cls} placeholder={ph} value={val} onChange={(e) => set(e.target.value)} onKeyDown={onKey} spellCheck={false} />
                );
              return (
                <div key={i} className={cn('flex items-center gap-1.5', c.enabled === false && 'opacity-50')}>
                  <span className="w-9 text-right text-[10.5px] font-semibold text-subtle">{i === 0 ? 'WHERE' : 'AND'}</span>
                  <Checkbox checked={c.enabled !== false} onCheckedChange={(v) => setCond(i, { enabled: v })} />
                  <Select size="sm" className="w-44" value={c.column} onChange={(e) => setCond(i, { column: e.target.value })} options={colOptions} />
                  <Select size="sm" className="w-40" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as FilterOp })} options={OPS} />
                  {noValue ? null : c.op === 'BETWEEN' ? (
                    <>
                      {valueInput(c.values?.[0] ?? '', (v) => setCond(i, { values: [v, c.values?.[1] ?? ''] }), 'from', 'w-32')}
                      <span className="text-[11px] text-subtle">and</span>
                      {valueInput(c.values?.[1] ?? '', (v) => setCond(i, { values: [c.values?.[0] ?? '', v] }), 'to', 'w-32')}
                    </>
                  ) : c.op === 'IN' || c.op === 'NOT IN' ? (
                    <Input
                      size="sm"
                      className="w-72"
                      placeholder="a, b, c   (quote values containing commas)"
                      value={c.value ?? c.values?.join(', ') ?? ''}
                      onChange={(e) => setCond(i, { value: e.target.value, values: undefined })}
                      onKeyDown={onKey}
                    />
                  ) : (
                    valueInput(c.value ?? '', (v) => setCond(i, { value: v }), c.op.includes('LIKE') ? '%text%' : 'value')
                  )}
                  <IconButton size="xs" label="Remove condition" onClick={() => remove(i)}><X size={13} /></IconButton>
                </div>
              );
            })}
            <div className="flex items-center gap-1.5 pl-[42px]">
              <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={add}>{draft.conditions.length ? 'Add condition' : 'Add filter condition'}</Button>
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={onClear}>Clear</Button>
          <Button size="xs" variant={dirty ? 'primary' : 'secondary'} onClick={onApply}>Apply</Button>
        </div>
      </div>
    </div>
  );
}
