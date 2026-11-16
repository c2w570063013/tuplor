import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, width = 520, className }: DialogProps) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="animate-fade-in fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <RD.Content
          style={{ width }}
          className={cn(
            'animate-pop-in fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-xl border border-border bg-elevated shadow-pop outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
            <div>
              <RD.Title className="text-[15px] font-semibold text-fg">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-0.5 text-xs text-muted">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RD.Description>
              )}
            </div>
            <RD.Close className="-mr-1 rounded-md p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Close">
              <X size={16} />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
