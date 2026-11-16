import * as RT from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Kbd } from './Kbd';

export const TooltipProvider = RT.Provider;

export function Tooltip({
  content, shortcut, children, side = 'bottom', delay,
}: { content: ReactNode; shortcut?: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }) {
  if (!content) return <>{children}</>;
  return (
    <RT.Root delayDuration={delay ?? 350}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          className="animate-fade-in z-[100] flex max-w-xs items-center gap-2 rounded-md border border-border bg-elevated px-2 py-1 text-xs text-fg shadow-pop"
        >
          {content}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
