import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary: 'bg-active text-fg hover:bg-[color-mix(in_srgb,var(--active),var(--fg)_6%)]',
  outline: 'border border-border-strong bg-transparent text-fg hover:bg-hover',
  ghost: 'bg-transparent text-muted hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3.5 text-[13px] gap-2 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={12} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: 'xs' | 'sm' | 'md';
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}

/** Square icon-only button with a tooltip. `label` is required for accessibility. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, active, size = 'sm', className, children, tooltipSide, ...rest },
  ref,
) {
  const s = size === 'xs' ? 'h-5 w-5 rounded' : size === 'sm' ? 'h-7 w-7 rounded-md' : 'h-8 w-8 rounded-md';
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center text-muted transition-colors duration-100 hover:bg-hover hover:text-fg',
          'disabled:pointer-events-none disabled:opacity-40',
          active && 'bg-active text-fg',
          s,
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});
