import * as DM from '@radix-ui/react-dropdown-menu';
import * as CM from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Menu primitives. Describe items declaratively:
 *   <DropdownMenu trigger={<button/>} items={[{ label, icon, onSelect, shortcut, danger }, 'separator', { label, items: [...] }]} />
 *   <ContextMenu items={...}><div>right-click me</div></ContextMenu>
 */
export type MenuItem =
  | 'separator'
  | { label: ReactNode; icon?: ReactNode; shortcut?: string; onSelect?: () => void; danger?: boolean; disabled?: boolean; items?: MenuItem[] }
  | { heading: ReactNode };

const content = 'animate-pop-in z-[90] min-w-[180px] rounded-lg border border-border bg-elevated p-1 text-[13px] text-fg shadow-pop';
const item =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none ' +
  'data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40';

function renderItems(items: MenuItem[], P: typeof DM | typeof CM): ReactNode {
  return items.map((it, i) => {
    if (it === 'separator') return <P.Separator key={i} className="my-1 h-px bg-border" />;
    if ('heading' in it) return <P.Label key={i} className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-subtle">{it.heading}</P.Label>;
    if (it.items) {
      return (
        <P.Sub key={i}>
          <P.SubTrigger className={item}>
            <span className="flex w-4 justify-center opacity-80">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            <span className="text-xs opacity-60">›</span>
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className={content} sideOffset={4}>{renderItems(it.items, P)}</P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    return (
      <P.Item
        key={i}
        disabled={it.disabled}
        onSelect={it.onSelect}
        className={cn(item, it.danger && 'text-danger data-[highlighted]:bg-danger data-[highlighted]:text-white')}
      >
        <span className="flex w-4 justify-center opacity-80">{it.icon}</span>
        <span className="flex-1 truncate">{it.label}</span>
        {it.shortcut && <span className="ml-4 text-[11px] opacity-60">{it.shortcut}</span>}
      </P.Item>
    );
  });
}

export function DropdownMenu({
  trigger, items, align = 'start', side = 'bottom',
}: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' | 'center'; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} side={side} sideOffset={4} className={content}>
          {renderItems(items, DM)}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function ContextMenu({ items, children, onOpenChange }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; onOpenChange?: (o: boolean) => void }) {
  return (
    <CM.Root modal={false} onOpenChange={onOpenChange}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={content}>{renderItems(typeof items === 'function' ? items() : items, CM)}</CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
