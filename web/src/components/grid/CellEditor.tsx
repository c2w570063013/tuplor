import { Check } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { cellToText } from './cell';
import type { CellEditorSpec, CellValue, EditorOption } from './types';

export type EditMove = 'down' | 'up' | 'right' | 'left' | 'none';

interface Props {
  spec: CellEditorSpec;
  value: CellValue;
  /** Text typed to start editing (replaces the value). */
  initial?: string;
  width: number;
  height: number;
  fontSize: number;
  onCommit: (v: CellValue, move: EditMove) => void;
  onCancel: () => void;
}

/** Inline cell editor: text input or option picker (bool / enum). Positioned by the grid. */
export function CellEditor(props: Props) {
  return props.spec.kind === 'choice' ? <ChoiceEditor {...props} /> : <TextEditor {...props} />;
}

function moveFor(e: React.KeyboardEvent): EditMove | null {
  if (e.key === 'Enter') return e.shiftKey ? 'up' : 'down';
  if (e.key === 'Tab') return e.shiftKey ? 'left' : 'right';
  return null;
}

function TextEditor({ spec, value, initial, width, height, fontSize, onCommit, onCancel }: Props) {
  const startText = initial ?? (value === null ? '' : cellToText(value));
  const [text, setText] = useState(startText);
  const touched = useRef(initial !== undefined);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (initial === undefined) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (move: EditMove) => {
    if (done.current) return;
    done.current = true;
    // Opening the editor on NULL and leaving it untouched keeps NULL (never silently turns into '').
    if (!touched.current) onCommit(value, move);
    else onCommit(text, move);
  };

  return (
    <input
      ref={ref}
      value={text}
      placeholder={value === null && !touched.current ? 'NULL' : spec.placeholder}
      spellCheck={false}
      onChange={(e) => { touched.current = true; setText(e.target.value); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const mv = moveFor(e);
        if (mv) { e.preventDefault(); finish(mv); }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel(); }
      }}
      onBlur={() => finish('none')}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="h-full w-full rounded-[3px] bg-elevated px-[7px] text-fg shadow-pop outline-none ring-2 ring-accent placeholder:text-null placeholder:italic"
      style={{ width: Math.max(width, 140), height, fontSize }}
    />
  );
}

function ChoiceEditor({ spec, value, initial, width, height, fontSize, onCommit, onCancel }: Props) {
  const options = useMemo<EditorOption[]>(
    () => [...(spec.options ?? []), ...(spec.nullable ? [{ label: 'NULL', value: null }] : [])],
    [spec],
  );
  const [filter, setFilter] = useState(initial ?? '');
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? options.filter((o) => o.label.toLowerCase().includes(f)) : options;
  }, [filter, options]);
  const currentIdx = Math.max(0, visible.findIndex((o) => o.value === value || (o.value !== null && value !== null && String(o.value) === String(value))));
  const [active, setActive] = useState(currentIdx);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { setActive(filter ? 0 : currentIdx); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (o: EditorOption | undefined, move: EditMove) => {
    if (done.current) return;
    done.current = true;
    if (o) onCommit(o.value, move);
    else onCancel();
  };

  return (
    <div className="relative" style={{ width: Math.max(width, 160) }} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={filter}
        placeholder={cellToText(value, 'NULL')}
        spellCheck={false}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(visible.length - 1, a + 1)); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return; }
          if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel(); return; }
          const mv = moveFor(e);
          if (mv) { e.preventDefault(); pick(visible[active], mv); }
        }}
        onBlur={() => { if (!done.current) { done.current = true; onCancel(); } }}
        className="w-full rounded-[3px] bg-elevated px-[7px] text-fg outline-none ring-2 ring-accent placeholder:text-subtle"
        style={{ height, fontSize }}
      />
      <div
        ref={listRef}
        className="animate-pop-in absolute top-full left-0 z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-elevated p-1 shadow-pop"
        style={{ fontSize }}
      >
        {visible.map((o, i) => {
          const selected = o.value === value || (o.value !== null && value !== null && String(o.value) === String(value));
          return (
            <div
              key={o.label + i}
              data-idx={i}
              onMouseDown={(e) => { e.preventDefault(); pick(o, 'none'); }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex h-6 cursor-default items-center gap-2 rounded px-2',
                i === active ? 'bg-accent text-accent-fg' : 'text-fg',
                o.value === null && i !== active && 'text-null italic',
              )}
            >
              <span className="w-3">{selected && <Check size={12} />}</span>
              <span className="truncate">{o.label}</span>
            </div>
          );
        })}
        {!visible.length && <div className="px-2 py-1.5 text-[11px] text-subtle">No match</div>}
      </div>
    </div>
  );
}
