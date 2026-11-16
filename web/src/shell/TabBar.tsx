import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ContextMenu } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useConnections } from '@/stores/connections';
import { confirm } from '@/stores/dialogs';
import { useWorkspace, type Tab } from '@/stores/workspace';
import { TAB_REGISTRY } from '@/features/registry';

export async function requestCloseTab(t: Tab) {
  if (t.dirty && !(await confirm({ title: `Close “${t.title}”?`, message: 'It has unsaved changes that will be lost.', danger: true, confirmLabel: 'Close' }))) return;
  useWorkspace.getState().closeTab(t.id);
}

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);
  const { setActiveTab, closeOthers, closeAll, moveTab, pinTab } = useWorkspace.getState();
  const conns = useConnections((s) => s.list);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  if (!tabs.length) return null;
  return (
    <div
      ref={scroller}
      className="flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-border bg-panel [scrollbar-width:none]"
      onWheel={(e) => { if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY; }}
    >
      {tabs.map((t, i) => {
        const Icon = TAB_REGISTRY[t.kind]?.icon;
        const color = conns.find((c) => c.id === t.connId)?.color;
        const active = t.id === activeId;
        return (
          <ContextMenu
            key={t.id}
            items={[
              { label: 'Close', onSelect: () => requestCloseTab(t) },
              { label: 'Close others', onSelect: () => closeOthers(t.id) },
              { label: 'Close all', onSelect: () => closeAll() },
              ...(t.preview ? ['separator' as const, { label: 'Keep open', onSelect: () => pinTab(t.id) }] : []),
            ]}
          >
            <div
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx !== null && dragIdx !== i) moveTab(dragIdx, i); setDragIdx(null); }}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); requestCloseTab(t); } }}
              onClick={() => setActiveTab(t.id)}
              onDoubleClick={() => pinTab(t.id)}
              title={[t.title, t.database && `${t.database}`].filter(Boolean).join(' · ')}
              className={cn(
                'group relative flex max-w-[220px] min-w-[110px] shrink-0 cursor-default items-center gap-1.5 border-r border-border pr-1.5 pl-3 text-[12.5px] select-none',
                active ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: color || 'var(--accent)' }} />}
              {Icon && <Icon size={13} className="shrink-0 opacity-80" style={color && !active ? undefined : undefined} />}
              <span className={cn('flex-1 truncate', t.preview && 'italic')}>{t.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); requestCloseTab(t); }}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg',
                  !active && !t.dirty && 'opacity-0 group-hover:opacity-100',
                )}
                aria-label="Close tab"
              >
                {t.dirty ? <span className="h-2 w-2 rounded-full bg-fg/60 group-hover:hidden" /> : null}
                <X size={12} className={cn(t.dirty && 'hidden group-hover:block')} />
              </button>
            </div>
          </ContextMenu>
        );
      })}
    </div>
  );
}
