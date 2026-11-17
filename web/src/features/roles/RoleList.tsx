import { ChevronRight, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { RoleInfo, RolesResponse } from '@shared/roles';
import { IconButton, Input, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ErrorState, LoadingState, RoleIcon, expiryInfo, sortRoles } from './parts';

interface Props {
  data: RolesResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  selected: string | undefined;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
}

type GroupKey = 'login' | 'group' | 'system';
const GROUP_LABEL: Record<GroupKey, string> = { login: 'Users', group: 'Groups', system: 'System roles' };

function readCollapsed(): Record<GroupKey, boolean> {
  try {
    return { login: false, group: false, system: true, ...JSON.parse(localStorage.getItem('tuplor.roles.collapsed') || '{}') };
  } catch {
    return { login: false, group: false, system: true };
  }
}

export function RoleList({ data, isLoading, isFetching, error, selected, onSelect, onCreate, onRefresh }: Props) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const listRef = useRef<HTMLDivElement>(null);

  const toggle = (g: GroupKey) =>
    setCollapsed((c) => {
      const n = { ...c, [g]: !c[g] };
      try { localStorage.setItem('tuplor.roles.collapsed', JSON.stringify(n)); } catch { /* ignore */ }
      return n;
    });

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const roles = (data?.roles ?? []).filter((r) => !f || r.name.toLowerCase().includes(f) || r.comment?.toLowerCase().includes(f));
    const out: { key: GroupKey; roles: RoleInfo[] }[] = [
      { key: 'login', roles: roles.filter((r) => !r.isSystem && r.canLogin).sort(sortRoles) },
      { key: 'group', roles: roles.filter((r) => !r.isSystem && !r.canLogin).sort(sortRoles) },
      { key: 'system', roles: roles.filter((r) => r.isSystem).sort(sortRoles) },
    ];
    return out;
  }, [data, filter]);

  // While filtering, show every group expanded so matches are visible.
  const isOpen = (g: GroupKey) => !!filter.trim() || !collapsed[g];
  const visible = useMemo(() => groups.flatMap((g) => (isOpen(g.key) ? g.roles : [])), [groups, collapsed, filter]);

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (!selected) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-role="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, data]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.name === selected);
    const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
    onSelect(visible[next].name);
  };

  const total = data ? data.roles.filter((r) => !r.isSystem).length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <ShieldCheck size={14} className="text-muted" />
        <span className="text-[13px] font-semibold text-fg">Roles</span>
        {data && <span className="text-[11px] text-subtle tabular-nums">{total}</span>}
        <div className="flex-1" />
        {isFetching && !isLoading && <Spinner size={12} className="mr-1 text-subtle" />}
        <IconButton label="Refresh" size="xs" onClick={onRefresh}><RefreshCw size={13} /></IconButton>
        <IconButton label={data && !data.canCreateRole ? 'You do not have CREATEROLE' : 'New role…'} size="xs" onClick={onCreate} disabled={!!data && !data.canCreateRole}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className="relative px-2 pt-2 pb-1.5">
        <Input
          size="sm"
          icon={<Search size={12} />}
          placeholder="Filter roles…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
            else onKeyDown(e);
          }}
        />
        {filter && (
          <button
            className="absolute top-1/2 right-3.5 mt-[1px] -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
            onClick={() => setFilter('')}
            aria-label="Clear filter"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-label="Roles" className="min-h-0 flex-1 overflow-auto px-1.5 pb-3 outline-none">
        {isLoading ? (
          <LoadingState label="Loading roles…" />
        ) : error ? (
          <ErrorState error={error} onRetry={onRefresh} title="Could not load roles" />
        ) : visible.length === 0 && filter ? (
          <div className="px-3 py-6 text-center text-xs text-subtle">No roles match “{filter}”</div>
        ) : (
          groups.map((g) =>
            g.roles.length === 0 && g.key !== 'login' ? null : (
              <div key={g.key} className="mt-1">
                <button
                  onClick={() => toggle(g.key)}
                  className="flex h-6 w-full items-center gap-1 rounded px-1.5 text-[10.5px] font-semibold tracking-wider text-subtle uppercase hover:text-muted"
                >
                  <ChevronRight size={12} className={cn('transition-transform duration-100', isOpen(g.key) && 'rotate-90')} />
                  <span className="flex-1 text-left">{GROUP_LABEL[g.key]}</span>
                  <span className="font-normal tabular-nums">{g.roles.length}</span>
                </button>
                {isOpen(g.key) &&
                  (g.roles.length === 0 ? (
                    <div className="px-7 py-1.5 text-xs text-subtle">No {GROUP_LABEL[g.key].toLowerCase()}</div>
                  ) : (
                    g.roles.map((r) => (
                      <RoleRow key={r.name} role={r} active={r.name === selected} isYou={r.name === data?.currentUser} onClick={() => onSelect(r.name)} />
                    ))
                  ))}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

function RoleRow({ role, active, isYou, onClick }: { role: RoleInfo; active: boolean; isYou: boolean; onClick: () => void }) {
  const exp = expiryInfo(role.validUntil);
  return (
    <div
      role="option"
      aria-selected={active}
      data-role={role.name}
      onClick={onClick}
      title={role.comment ?? undefined}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-2 rounded-md px-2 text-[13px] select-none',
        active ? 'bg-accent-soft text-fg' : 'hover:bg-hover',
      )}
    >
      <RoleIcon role={role} size={14} />
      <span className={cn('min-w-0 flex-1 truncate', exp.expired && 'text-subtle line-through decoration-subtle/60')}>{role.name}</span>
      {isYou && <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">you</span>}
      {role.superuser && !role.isSystem && <span className="rounded bg-warning-soft px-1 text-[10px] font-semibold text-warning">SU</span>}
      {role.members.length > 0 && !role.canLogin && (
        <span className="text-[10.5px] text-subtle tabular-nums" title={`${role.members.length} member(s)`}>{role.members.length}</span>
      )}
    </div>
  );
}
