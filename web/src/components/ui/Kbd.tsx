import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('rounded border border-border-strong bg-sunken px-1 font-sans text-[10px] font-medium text-muted', className)}>
      {children}
    </kbd>
  );
}
