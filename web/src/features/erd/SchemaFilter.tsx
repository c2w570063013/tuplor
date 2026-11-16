import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, FolderTree } from 'lucide-react';
import { Checkbox } from '@/components/ui';

export function SchemaFilter({
  schemas, selected, colors, onChange,
}: {
  schemas: { name: string; tables: number }[];
  selected: string[];
  colors: Map<string, string>;
  onChange: (next: string[]) => void;
}) {
  const sel = new Set(selected);
  const all = schemas.length > 0 && schemas.every((s) => sel.has(s.name));
  const label = all ? 'All schemas' : selected.length === 1 ? selected[0] : `${selected.length} schemas`;
  const toggle = (name: string, on: boolean) => {
    const next = schemas.map((s) => s.name).filter((n) => (n === name ? on : sel.has(n)));
    onChange(next);
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-bg px-2 text-xs text-fg hover:bg-hover">
          <FolderTree size={13} className="text-muted" />
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronDown size={12} className="text-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="animate-pop-in z-[90] w-60 rounded-lg border border-border bg-elevated p-1 shadow-pop">
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-[11px] font-medium text-subtle">
            <span>Schemas</span>
            <span className="flex gap-2">
              <button className="hover:text-fg" onClick={() => onChange(schemas.map((s) => s.name))}>All</button>
              <button className="hover:text-fg" onClick={() => onChange(schemas.filter((s) => s.tables > 0).map((s) => s.name))}>Non-empty</button>
            </span>
          </div>
          <div className="max-h-72 overflow-auto">
            {schemas.map((s) => (
              <label key={s.name} className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover">
                <Checkbox checked={sel.has(s.name)} onCheckedChange={(v) => toggle(s.name, v)} />
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colors.get(s.name) }} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-[11px] text-subtle tabular-nums">{s.tables}</span>
              </label>
            ))}
            {!schemas.length && <div className="px-2 py-3 text-xs text-muted">No schemas</div>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
