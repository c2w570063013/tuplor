import {
  ChevronRight, Columns3, Database, Eye, FolderTree, FunctionSquare, Hash, KeyRound, Layers, MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck,
  ShieldOff, Table2, X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { GrantTargetType, PrivObjectType, PrivilegeEntry, PrivilegeRequest, RoleInfo, RolesResponse } from '@shared/roles';
import { PRIVILEGES_BY_TARGET, PRIVILEGE_MIN_VERSION } from '@shared/roles';
import { Badge, Button, DropdownMenu, EmptyState, IconButton, Input, Select, Spinner, Tooltip, type MenuItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rolesApi, runPreviewed, toastError, usePrivileges } from './api';
import { GrantDialog, type GrantInitial } from './GrantDialog';
import { ErrorState, LoadingState } from './parts';

type Group = 'database' | 'schema' | 'table' | 'column' | 'sequence' | 'function';

const GROUPS: { key: Group; label: string; types: PrivObjectType[]; icon: ReactNode }[] = [
  { key: 'database', label: 'Database', types: ['database'], icon: <Database size={13} className="text-muted" /> },
  { key: 'schema', label: 'Schemas', types: ['schema'], icon: <FolderTree size={13} className="text-muted" /> },
  { key: 'table', label: 'Tables & views', types: ['table', 'view', 'materialized_view', 'foreign_table'], icon: <Table2 size={13} className="text-accent" /> },
  { key: 'column', label: 'Columns', types: ['column'], icon: <Columns3 size={13} className="text-accent" /> },
  { key: 'sequence', label: 'Sequences', types: ['sequence'], icon: <Hash size={13} className="text-syntax-number" /> },
  { key: 'function', label: 'Functions & procedures', types: ['function', 'procedure'], icon: <FunctionSquare size={13} className="text-syntax-keyword" /> },
];

const TYPE_ICON: Partial<Record<PrivObjectType, ReactNode>> = {
  view: <Eye size={13} className="text-info" />,
  materialized_view: <Layers size={13} className="text-info" />,
  foreign_table: <Table2 size={13} className="text-muted" />,
};

/** Canonical display order of privileges. */
const ORDER = ['CONNECT', 'CREATE', 'TEMPORARY', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'EXECUTE'];
const rank = (p: string) => (ORDER.indexOf(p) + 1 || 99);

/** Number of privileges that make up "ALL" for an object type on this server. */
function fullSetSize(t: PrivObjectType, versionNum: number): number {
  if (t === 'column') return 4;
  const target: GrantTargetType =
    t === 'database' || t === 'schema' || t === 'sequence' ? t : t === 'function' || t === 'procedure' ? 'function' : 'table';
  return PRIVILEGES_BY_TARGET[target].filter((p) => !PRIVILEGE_MIN_VERSION[p] || versionNum >= PRIVILEGE_MIN_VERSION[p]).length;
}

function groupOf(t: PrivObjectType): Group {
  return GROUPS.find((g) => g.types.includes(t))!.key;
}

function targetOf(e: PrivilegeEntry): { targetType: GrantTargetType; objects: PrivilegeRequest['objects']; columns?: string[] } {
  switch (e.objectType) {
    case 'database': return { targetType: 'database', objects: [{ name: e.name }] };
    case 'schema': return { targetType: 'schema', objects: [{ name: e.name }] };
    case 'sequence': return { targetType: 'sequence', objects: [{ schema: e.schema, name: e.name }] };
    case 'function':
    case 'procedure': return { targetType: 'function', objects: [{ schema: e.schema, name: e.name, oid: e.oid }] };
    case 'column': return { targetType: 'table', objects: [{ schema: e.schema, name: e.name }], columns: [e.column!] };
    default: return { targetType: 'table', objects: [{ schema: e.schema, name: e.name }] };
  }
}

function entryLabel(e: PrivilegeEntry): string {
  if (e.objectType === 'function' || e.objectType === 'procedure') return e.signature ?? `${e.schema}.${e.name}()`;
  if (e.objectType === 'column') return `${e.schema}.${e.name}.${e.column}`;
  return e.schema ? `${e.schema}.${e.name}` : e.name;
}

export function PrivilegesPanel({
  connId, data, role, db, databases, onDbChange,
}: { connId: string; data: RolesResponse; role: RoleInfo; db: string; databases: string[]; onDbChange: (db: string) => void }) {
  const q = usePrivileges(connId, db, role.name);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [collapsed, setCollapsed] = useState<Set<Group>>(new Set());
  const [grant, setGrant] = useState<GrantInitial | null>(null);

  const entries = q.data?.entries ?? [];
  const counts = useMemo(() => {
    const c = new Map<Group, number>();
    for (const e of entries) c.set(groupOf(e.objectType), (c.get(groupOf(e.objectType)) ?? 0) + 1);
    return c;
  }, [entries]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (group === 'all' || groupOf(e.objectType) === group) &&
        (!f || entryLabel(e).toLowerCase().includes(f) || e.privileges.some((p) => p.privilege.toLowerCase().includes(f) || p.grantor.toLowerCase().includes(f))),
    );
  }, [entries, filter, group]);

  const revoke = async (e: PrivilegeEntry, privileges: string[], grantOption = false) => {
    const t = targetOf(e);
    const label = entryLabel(e);
    try {
      await runPreviewed({
        connId,
        db,
        title: grantOption ? 'Revoke grant option' : 'Revoke privileges',
        danger: !grantOption,
        confirmLabel: 'Revoke',
        success: grantOption ? `Grant option revoked on ${label}` : `Revoked ${privileges.length === 1 ? privileges[0] : 'privileges'} on ${label}`,
        call: (dryRun) =>
          rolesApi.setPrivileges(connId, db, { action: 'revoke', ...t, privileges, grantees: [role.name], grantOption, dryRun }),
      });
    } catch (err) {
      toastError(err, 'Revoke failed');
    }
  };

  const toggleCollapsed = (g: Group) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g); else n.add(g);
      return n;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Tooltip content="Privileges are per database">
          <span className="flex items-center"><Database size={13} className="text-subtle" /></span>
        </Tooltip>
        <Select
          size="sm"
          className="w-44"
          value={db}
          onChange={(e) => onDbChange(e.target.value)}
          options={(databases.includes(db) ? databases : [db, ...databases]).map((d) => ({ value: d, label: d }))}
        />
        <Input size="sm" icon={<Search size={12} />} placeholder="Filter objects or privileges…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-60" />
        <Select
          size="sm"
          className="w-44"
          value={group}
          onChange={(e) => setGroup(e.target.value as Group | 'all')}
          options={[
            { value: 'all', label: `All types (${entries.length})` },
            ...GROUPS.map((g) => ({ value: g.key, label: `${g.label} (${counts.get(g.key) ?? 0})` })),
          ]}
        />
        <div className="flex-1" />
        {q.isFetching && !q.isLoading && <Spinner size={12} className="text-subtle" />}
        <IconButton label="Refresh" size="sm" onClick={() => q.refetch()}><RefreshCw size={13} /></IconButton>
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setGrant({ action: 'grant' })}>Grant…</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading ? (
          <LoadingState label={`Loading privileges in ${db}…`} />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load privileges" />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<KeyRound size={26} />}
            title={`No explicit privileges in ${db}`}
            description={
              role.superuser
                ? 'This role is a superuser and bypasses all permission checks.'
                : 'Privileges inherited through role membership, owned objects and grants to PUBLIC are not listed here.'
            }
            action={<Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setGrant({ action: 'grant' })}>Grant privileges…</Button>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Search size={22} />} title="No matches" description="Try a different filter." />
        ) : (
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col />
              <col className="w-[44%]" />
              <col className="w-32" />
              <col className="w-12" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-grid-header">
              <tr className="text-left text-[11px] text-subtle">
                <th className="h-7 border-b border-border px-4 font-medium">Object</th>
                <th className="h-7 border-b border-border px-2 font-medium">Privileges</th>
                <th className="h-7 border-b border-border px-2 font-medium">Granted by</th>
                <th className="h-7 border-b border-border" />
              </tr>
            </thead>
            {GROUPS.map((g) => {
              const rows = filtered.filter((e) => groupOf(e.objectType) === g.key);
              if (!rows.length) return null;
              const open = !collapsed.has(g.key);
              return (
                <tbody key={g.key}>
                  <tr className="cursor-default bg-panel select-none" onClick={() => toggleCollapsed(g.key)}>
                    <td colSpan={4} className="h-7 border-b border-border px-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
                        <ChevronRight size={12} className={cn('text-subtle transition-transform duration-100', open && 'rotate-90')} />
                        {g.icon}
                        {g.label}
                        <span className="font-normal text-subtle tabular-nums">{rows.length}</span>
                      </div>
                    </td>
                  </tr>
                  {open && rows.map((e) => <PrivRow key={`${e.objectType}:${entryLabel(e)}:${e.oid ?? ''}`} entry={e} versionNum={data.versionNum} onRevoke={revoke} onEdit={() => setGrant({ action: 'grant', fromEntry: e })} />)}
                </tbody>
              );
            })}
          </table>
        )}
      </div>
      {grant && (
        <GrantDialog connId={connId} db={db} data={data} role={role} initial={grant} onClose={() => setGrant(null)} />
      )}
    </div>
  );
}

function PrivRow({
  entry, versionNum, onRevoke, onEdit,
}: { entry: PrivilegeEntry; versionNum: number; onRevoke: (e: PrivilegeEntry, privs: string[], grantOption?: boolean) => void; onEdit: () => void }) {
  const privs = [...entry.privileges].sort((a, b) => rank(a.privilege) - rank(b.privilege));
  const full = privs.length > 1 && privs.length >= fullSetSize(entry.objectType, versionNum);
  const allGrantable = privs.every((p) => p.grantable);
  const chips = full
    ? [{ privilege: 'ALL', grantable: allGrantable, grantor: privs[0].grantor, title: privs.map((p) => p.privilege + (p.grantable ? '*' : '')).join(', ') }]
    : privs.map((p) => ({ ...p, title: '' }));
  const grantors = [...new Set(privs.map((p) => p.grantor))];
  const anyGrantable = privs.some((p) => p.grantable);
  const icon = TYPE_ICON[entry.objectType] ?? GROUPS.find((g) => g.types.includes(entry.objectType))!.icon;
  const items: MenuItem[] = [
    { label: 'Grant more…', icon: <Plus size={13} />, onSelect: onEdit },
    ...(anyGrantable
      ? [{ label: 'Revoke grant option', icon: <ShieldOff size={13} />, onSelect: () => onRevoke(entry, privs.filter((p) => p.grantable).map((p) => p.privilege), true) }]
      : []),
    'separator',
    { heading: 'Revoke' },
    ...privs.map((p) => ({ label: p.privilege, icon: <X size={13} />, onSelect: () => onRevoke(entry, [p.privilege]) })),
    ...(privs.length > 1
      ? (['separator', { label: 'Revoke all…', icon: <X size={13} />, danger: true, onSelect: () => onRevoke(entry, privs.map((p) => p.privilege)) }] as MenuItem[])
      : []),
  ];
  return (
    <tr className="group border-b border-grid-line hover:bg-hover">
      <td className="h-8 px-4">
        <div className="flex min-w-0 items-center gap-2 pl-4">
          <span className="flex shrink-0">{icon}</span>
          <span className="truncate font-mono text-[12px] text-fg" title={entryLabel(entry)}>
            {entry.schema && <span className="text-subtle">{entry.schema}.</span>}
            {entry.name}
            {(entry.objectType === 'function' || entry.objectType === 'procedure') && <span className="text-muted">({entry.args ?? ''})</span>}
            {entry.column && <span className="text-muted">.{entry.column}</span>}
          </span>
          {entry.objectType === 'procedure' && <Badge>procedure</Badge>}
          {entry.objectType !== 'table' && TYPE_ICON[entry.objectType] && <Badge>{entry.objectType.replace('_', ' ')}</Badge>}
          {entry.isOwner && (
            <Tooltip content="This role owns the object; owners implicitly have all privileges">
              <span><Badge tone="accent">owner</Badge></span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-1">
          {chips.map((p) => (
            <Tooltip
              key={p.privilege}
              content={p.title ? `All privileges: ${p.title}` : p.grantable ? `${p.privilege} WITH GRANT OPTION (granted by ${p.grantor})` : `${p.privilege} (granted by ${p.grantor})`}
            >
              <span
                className={cn(
                  'inline-flex h-[18px] items-center gap-0.5 rounded px-1.5 font-mono text-[10.5px] font-medium',
                  p.grantable ? 'bg-accent-soft text-accent ring-1 ring-accent/30' : 'bg-active text-muted',
                )}
              >
                {p.privilege}
                {p.grantable && <ShieldCheck size={10} />}
              </span>
            </Tooltip>
          ))}
        </div>
      </td>
      <td className="truncate px-2 text-xs text-muted" title={grantors.join(', ')}>{grantors.join(', ')}</td>
      <td className="pr-3 text-right">
        <DropdownMenu
          align="end"
          trigger={<IconButton label="Actions" size="xs" className="opacity-60 group-hover:opacity-100"><MoreHorizontal size={14} /></IconButton>}
          items={items}
        />
      </td>
    </tr>
  );
}
