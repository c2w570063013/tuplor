import '@/lib/monaco';
import { Editor } from '@monaco-editor/react';
import * as Popover from '@radix-ui/react-popover';
import { AlertCircle, Check, Copy, KeyRound, Link2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TypeSuggestion } from '@shared/schema';
import { Button, ContextMenu, EmptyState, Spinner, type MenuItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { monacoTheme } from '@/lib/monaco';
import { useResolvedTheme } from '@/stores/settings';
import { errorText } from './api';

// ------------------------------------------------------------------ data table

export interface Col<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
}

/** Compact, styled (non-virtualized) table for catalog listings. */
export function DataTable<T>({
  columns, rows, rowKey, rowMenu, onRowDoubleClick, rowClassName, empty, className, dense,
}: {
  columns: Col<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  rowMenu?: (row: T) => MenuItem[];
  onRowDoubleClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined | false;
  empty?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className={cn('overflow-auto', className)}>
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                className={cn(
                  'sticky top-0 z-[1] h-8 border-b border-border bg-grid-header px-3 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-subtle uppercase',
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                  c.headerClassName,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tr = (
              <tr
                key={rowKey(r, i)}
                onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(r) : undefined}
                className={cn('group hover:bg-hover', rowClassName?.(r))}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'border-b border-grid-line px-3 align-middle',
                      dense ? 'h-8' : 'h-9',
                      c.align === 'right' && 'text-right tabular-nums',
                      c.align === 'center' && 'text-center',
                      c.className,
                    )}
                  >
                    {c.render(r, i)}
                  </td>
                ))}
              </tr>
            );
            return rowMenu ? <ContextMenu key={rowKey(r, i)} items={() => rowMenu(r)}>{tr}</ContextMenu> : <Fragment key={rowKey(r, i)}>{tr}</Fragment>;
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ small bits

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('font-mono text-[12px]', className)}>{children}</span>;
}

export function TypeText({ type, className }: { type: string; className?: string }) {
  return <span className={cn('font-mono text-[12px] text-syntax-keyword', className)}>{type}</span>;
}

export function PkIcon({ size = 12 }: { size?: number }) {
  return <KeyRound size={size} className="shrink-0 text-warning" aria-label="Primary key" />;
}
export function FkIcon({ size = 12 }: { size?: number }) {
  return <Link2 size={size} className="shrink-0 text-info" aria-label="Foreign key" />;
}

export function Chips({ items, mono = true }: { items: string[]; mono?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((c, i) => (
        <span key={i} className={cn('rounded bg-active px-1.5 py-px text-[11.5px] text-fg', mono && 'font-mono')}>{c}</span>
      ))}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {label}
    </Button>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center gap-2 text-xs text-muted">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertCircle size={26} className="text-danger" />}
      title="Could not load"
      description={errorText(error)}
      action={onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    />
  );
}

export function SectionToolbar({ title, count, children, description }: { title: ReactNode; count?: number; children?: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          {title}
          {count != null && <span className="rounded-full bg-active px-1.5 text-[11px] font-medium text-muted tabular-nums">{count}</span>}
        </div>
        {description && <div className="mt-0.5 truncate text-[11.5px] text-subtle">{description}</div>}
      </div>
      {children}
    </div>
  );
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[12.5px]', className)}>
      {items.map(([k, v], i) => (
        <Fragment key={i}>
          <dt className="text-subtle">{k}</dt>
          <dd className="min-w-0 text-fg">{v ?? <span className="text-subtle">—</span>}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function StatCard({ label, value, sub, tone, icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'danger' | 'warning' | 'success'; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-panel px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-subtle uppercase">{icon}{label}</div>
      <div className={cn('mt-1 text-lg font-semibold text-fg tabular-nums', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success')}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-panel', className)}>
      {(title || actions) && (
        <header className="flex h-10 items-center gap-2 border-b border-border px-3.5">
          <div className="flex-1 text-[12.5px] font-semibold text-fg">{title}</div>
          {actions}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString();
}

// ------------------------------------------------------------------ code view

/** Read-only Monaco SQL viewer that follows the app theme. */
export function CodeView({ value, className, language = 'sql', onChange, readOnly = true }: { value: string; className?: string; language?: string; onChange?: (v: string) => void; readOnly?: boolean }) {
  const theme = useResolvedTheme();
  return (
    <div className={cn('min-h-0', className)}>
      <Editor
        value={value}
        language={language}
        theme={monacoTheme(theme)}
        onChange={(v) => onChange?.(v ?? '')}
        loading={<Loading />}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          fontSize: 12.5,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          renderLineHighlight: readOnly ? 'none' : 'line',
          wordWrap: 'on',
          padding: { top: 10, bottom: 10 },
          automaticLayout: true,
          folding: true,
          guides: { indentation: false },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          overviewRulerLanes: 0,
          contextmenu: true,
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ type combobox

const KIND_BADGE: Record<TypeSuggestion['kind'], string> = {
  base: '', enum: 'enum', domain: 'domain', composite: 'type', range: 'range',
};

/** Text input for a PostgreSQL type with a filtered suggestion list (base types + user enums/domains/types). */
export function TypeInput({
  value, onChange, suggestions, className, placeholder = 'type', autoFocus, invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: TypeSuggestion[];
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [typed, setTyped] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const q = typed ? value.trim().toLowerCase() : '';
    const list = q ? suggestions.filter((s) => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)) : suggestions;
    return list.slice(0, 80);
  }, [suggestions, value, typed]);
  useEffect(() => setHi(0), [value]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (s: TypeSuggestion) => {
    onChange(s.name);
    setOpen(false);
    setTyped(false);
  };

  return (
    <Popover.Root open={open && items.length > 0} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <input
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onFocus={() => { setOpen(true); setTyped(false); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); }}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); e.preventDefault(); return; }
            if (!open) return;
            if (e.key === 'ArrowDown') { setHi((h) => Math.min(h + 1, items.length - 1)); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { setHi((h) => Math.max(h - 1, 0)); e.preventDefault(); }
            else if (e.key === 'Enter' && items[hi] && typed) { pick(items[hi]); e.preventDefault(); }
            else if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); }
          }}
          className={cn(
            'h-7 w-full rounded-md border border-border-strong bg-bg px-2 font-mono text-[12px] text-syntax-keyword outline-none placeholder:font-sans placeholder:text-subtle',
            'focus:border-accent focus:ring-2 focus:ring-accent-soft',
            invalid && 'border-danger',
            className,
          )}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="animate-pop-in z-[95] w-[300px] rounded-lg border border-border bg-elevated p-1 shadow-pop"
        >
          <div ref={listRef} className="max-h-[280px] overflow-auto">
            {items.map((s, i) => {
              const showGroup = i === 0 || items[i - 1].group !== s.group;
              return (
                <Fragment key={s.name + i}>
                  {showGroup && <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-wider text-subtle uppercase">{s.group}</div>}
                  <div
                    data-i={i}
                    onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                    onMouseEnter={() => setHi(i)}
                    className={cn('flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px]', i === hi && 'bg-accent text-accent-fg')}
                  >
                    <span className="font-mono">{s.name}</span>
                    {KIND_BADGE[s.kind] && <span className={cn('rounded px-1 text-[10px]', i === hi ? 'bg-white/20' : 'bg-success-soft text-success')}>{KIND_BADGE[s.kind]}</span>}
                    <span className={cn('ml-auto truncate text-[11px]', i === hi ? 'text-accent-fg/80' : 'text-subtle')}>{s.description}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Small inline text input used in editable grids. */
export function CellInput({ value, onChange, mono, placeholder, className, changed, autoFocus }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string; className?: string; changed?: boolean; autoFocus?: boolean }) {
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-7 w-full rounded-md border border-transparent bg-transparent px-2 text-[12.5px] text-fg outline-none placeholder:text-subtle hover:border-border-strong',
        'focus:border-accent focus:bg-bg focus:ring-2 focus:ring-accent-soft',
        mono && 'font-mono text-[12px]',
        changed && 'border-warning/50 bg-warning-soft',
        className,
      )}
    />
  );
}

/** Empty state sized for a section body. */
export function EmptyBlock({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return <EmptyState className="h-auto min-h-48 flex-1" icon={icon} title={title} description={description} action={action} />;
}
