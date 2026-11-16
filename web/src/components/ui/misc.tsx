import * as RSwitch from '@radix-ui/react-switch';
import * as RCheck from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; className?: string }) {
  const tones = {
    neutral: 'bg-active text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  };
  return <span className={cn('inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Switch({ checked, onCheckedChange, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative h-[18px] w-8 shrink-0 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <RSwitch.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[16px]" />
    </RSwitch.Root>
  );
}

export function Checkbox({ checked, onCheckedChange, disabled, className }: { checked: boolean | 'indeterminate'; onCheckedChange: (v: boolean) => void; disabled?: boolean; className?: string }) {
  return (
    <RCheck.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border-strong bg-bg',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        className,
      )}
    >
      <RCheck.Indicator className="text-white">
        {checked === 'indeterminate' ? <Minus size={10} strokeWidth={3} /> : <Check size={10} strokeWidth={3} />}
      </RCheck.Indicator>
    </RCheck.Root>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      {icon && <div className="mb-1 text-subtle">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {description && <div className="max-w-sm text-xs text-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A segmented control (e.g. Data | Structure | DDL). */
export function Segmented<T extends string>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode }[]; size?: 'xs' | 'sm' }) {
  return (
    <div className="inline-flex rounded-md bg-sunken p-0.5 ring-1 ring-border">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[5px] px-2.5 font-medium transition-colors',
            size === 'xs' ? 'h-5 text-[11px]' : 'h-6 text-xs',
            value === o.value ? 'bg-elevated text-fg shadow-sm ring-1 ring-border' : 'text-muted hover:text-fg',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Horizontal toolbar container used at the top of tabs. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-10 shrink-0 items-center gap-1 border-b border-border bg-bg px-2', className)}>{children}</div>;
}

export function ToolbarDivider() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}
