import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

const field =
  'w-full rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-subtle outline-none transition-colors ' +
  'focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-50';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: ReactNode;
  size?: 'sm' | 'md';
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, icon, size = 'md', mono, ...rest }, ref) {
  const h = size === 'sm' ? 'h-7 text-xs' : 'h-8';
  if (icon) {
    return (
      <div className={cn('relative', className)}>
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-subtle">{icon}</span>
        <input ref={ref} className={cn(field, h, 'pl-7', mono && 'font-mono')} {...rest} />
      </div>
    );
  }
  return <input ref={ref} className={cn(field, h, mono && 'font-mono', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...rest }, ref) {
    return <textarea ref={ref} className={cn(field, 'py-1.5', mono && 'font-mono text-xs', className)} {...rest} />;
  },
);

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: { value: string; label: string }[];
  size?: 'sm' | 'md';
}

/** Native select, styled. Good for forms. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, className, size = 'md', ...rest }, ref) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} className={cn(field, size === 'sm' ? 'h-7 text-xs' : 'h-8', 'appearance-none pr-7')} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-subtle" />
    </div>
  );
});

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}
