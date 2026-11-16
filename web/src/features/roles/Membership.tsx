import { Check, Minus, MoreHorizontal, Plus, Search, ShieldCheck, ShieldOff, UserMinus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MembershipRequest, RoleInfo, RoleMembership, RolesResponse } from '@shared/roles';
import { Button, Checkbox, Dialog, DropdownMenu, EmptyState, IconButton, Input, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rolesApi, runPreviewed, toastError } from './api';
import { InlineError, OptionLabel, RoleIcon, sortRoles } from './parts';

type Mode = 'memberOf' | 'members';

const COPY: Record<Mode, { empty: string; emptyDesc: string; add: string; col: string }> = {
  memberOf: {
    empty: 'Not a member of any role',
    emptyDesc: 'Add this role to a group role to let it inherit (or SET ROLE to) that role’s privileges.',
    add: 'Add to role…',
    col: 'Granted role',
  },
  members: {
    empty: 'No members',
    emptyDesc: 'Roles that are members of this role can use its privileges.',
    add: 'Add members…',
    col: 'Member',
  },
};

/** Table of memberships (either the roles this role belongs to, or this role's members). */
export function MembershipPanel({
  connId, data, role, mode, onNavigate,
}: { connId: string; data: RolesResponse; role: RoleInfo; mode: Mode; onNavigate: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  const rows = mode === 'memberOf' ? role.memberOf : role.members;
  const pg16 = data.versionNum >= 160000;
  const byName = useMemo(() => new Map(data.roles.map((r) => [r.name, r])), [data.roles]);
  const readOnly = !data.canCreateRole;

  /** Express a membership row as (granted role, member). */
  const pair = (m: RoleMembership) => (mode === 'memberOf' ? { roles: [m.role], members: [role.name] } : { roles: [role.name], members: [m.role] });

  const run = async (req: Omit<MembershipRequest, 'dryRun'>, title: string, success: string, danger = false) => {
    try {
      await runPreviewed({ connId, title, success, danger, call: (dryRun) => rolesApi.membership(connId, { ...req, dryRun }) });
    } catch (e) {
      toastError(e, 'Membership change failed');
    }
  };

  const revoke = (m: RoleMembership) => {
    const p = pair(m);
    void run({ action: 'revoke', ...p }, 'Revoke membership', `${p.members[0]} removed from ${p.roles[0]}`, true);
  };
  const setAdmin = (m: RoleMembership, on: boolean) => {
    const p = pair(m);
    void run(
      on ? { action: 'grant', ...p, adminOption: true } : { action: 'revoke', ...p, adminOption: true },
      on ? 'Grant admin option' : 'Revoke admin option',
      on ? `Admin option granted to ${p.members[0]}` : `Admin option revoked from ${p.members[0]}`,
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-xs text-muted">
          {mode === 'memberOf' ? (
            <><span className="font-medium text-fg">{role.name}</span> is a member of {rows.length} role{rows.length === 1 ? '' : 's'}</>
          ) : (
            <>{rows.length} role{rows.length === 1 ? '' : 's'} {rows.length === 1 ? 'is a' : 'are'} member{rows.length === 1 ? '' : 's'} of <span className="font-medium text-fg">{role.name}</span></>
          )}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={<Plus size={13} />} onClick={() => setAdding(true)} disabled={readOnly}>
          {COPY[mode].add}
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={<Users size={26} />}
          title={COPY[mode].empty}
          description={COPY[mode].emptyDesc}
          action={!readOnly && <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>{COPY[mode].add}</Button>}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-grid-header">
              <tr className="text-left text-[11px] font-medium text-subtle">
                <th className="h-7 border-b border-border px-4 font-medium">{COPY[mode].col}</th>
                <th className="h-7 w-24 border-b border-border px-2 text-center font-medium">
                  <Tooltip content="WITH ADMIN OPTION: the member can grant this role to others"><span>Admin</span></Tooltip>
                </th>
                {pg16 && (
                  <>
                    <th className="h-7 w-24 border-b border-border px-2 text-center font-medium">
                      <Tooltip content="INHERIT option: privileges are used automatically"><span>Inherit</span></Tooltip>
                    </th>
                    <th className="h-7 w-24 border-b border-border px-2 text-center font-medium">
                      <Tooltip content="SET option: the member can SET ROLE to this role"><span>Set role</span></Tooltip>
                    </th>
                  </>
                )}
                <th className="h-7 w-40 border-b border-border px-2 font-medium">Granted by</th>
                <th className="h-7 w-12 border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => {
                const other = byName.get(m.role);
                return (
                  <tr key={`${m.role}:${m.grantor}:${i}`} className="group border-b border-grid-line hover:bg-hover">
                    <td className="h-8 px-4">
                      <button className="flex items-center gap-2 text-left hover:underline" onClick={() => onNavigate(m.role)} title={`Open ${m.role}`}>
                        {other && <RoleIcon role={other} size={14} />}
                        <span className="text-fg">{m.role}</span>
                      </button>
                    </td>
                    <td className="px-2 text-center"><Flag on={m.admin} /></td>
                    {pg16 && (
                      <>
                        <td className="px-2 text-center"><Flag on={m.inherit} /></td>
                        <td className="px-2 text-center"><Flag on={m.set} /></td>
                      </>
                    )}
                    <td className="truncate px-2 text-xs text-muted">{m.grantor ?? '—'}</td>
                    <td className="pr-3 text-right">
                      {!readOnly && (
                        <DropdownMenu
                          align="end"
                          trigger={
                            <IconButton label="Actions" size="xs" className="opacity-60 group-hover:opacity-100"><MoreHorizontal size={14} /></IconButton>
                          }
                          items={[
                            m.admin
                              ? { label: 'Revoke admin option', icon: <ShieldOff size={13} />, onSelect: () => setAdmin(m, false) }
                              : { label: 'Grant admin option', icon: <ShieldCheck size={13} />, onSelect: () => setAdmin(m, true) },
                            'separator',
                            { label: 'Revoke membership…', icon: <UserMinus size={13} />, danger: true, onSelect: () => revoke(m) },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <MembershipDialog connId={connId} data={data} role={role} mode={mode} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Flag({ on }: { on: boolean | null }) {
  if (on == null) return <span className="text-subtle">—</span>;
  return on ? <Check size={14} className="mx-auto text-success" /> : <Minus size={14} className="mx-auto text-subtle" />;
}

function MembershipDialog({ connId, data, role, mode, onClose }: { connId: string; data: RolesResponse; role: RoleInfo; mode: Mode; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [inherit, setInherit] = useState(true);
  const [setOpt, setSetOpt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pg16 = data.versionNum >= 160000;

  const existing = new Set((mode === 'memberOf' ? role.memberOf : role.members).map((m) => m.role));
  const candidates = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return data.roles
      .filter((r) => r.name !== role.name && !existing.has(r.name))
      // members can't be built-in roles in a useful way; groups can (pg_read_all_data, pg_monitor, …)
      .filter((r) => mode === 'memberOf' || !r.isSystem)
      .filter((r) => !f || r.name.toLowerCase().includes(f))
      .sort((a, b) => Number(a.isSystem) - Number(b.isSystem) || sortRoles(a, b));
  }, [data.roles, filter, role.name, mode]);

  const toggle = (n: string) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  const submit = async () => {
    setError(null);
    setBusy(true);
    const req: Omit<MembershipRequest, 'dryRun'> = {
      action: 'grant',
      roles: mode === 'memberOf' ? picked : [role.name],
      members: mode === 'memberOf' ? [role.name] : picked,
      adminOption: admin,
      ...(pg16 && !inherit ? { inheritOption: false } : {}),
      ...(pg16 && !setOpt ? { setOption: false } : {}),
    };
    try {
      const ok = await runPreviewed({
        connId,
        title: 'Grant membership',
        success: mode === 'memberOf' ? `${role.name} added to ${picked.length} role${picked.length === 1 ? '' : 's'}` : `${picked.length} member${picked.length === 1 ? '' : 's'} added to ${role.name}`,
        call: (dryRun) => rolesApi.membership(connId, { ...req, dryRun }),
        confirmLabel: 'Grant',
      });
      if (ok) onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={480}
      title={mode === 'memberOf' ? `Add ${role.name} to roles` : `Add members to ${role.name}`}
      description={mode === 'memberOf' ? 'Pick the group roles to grant.' : 'Pick the roles that should become members.'}
      footer={
        <>
          <span className="mr-auto text-[11px] text-subtle">{picked.length} selected</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" loading={busy} disabled={!picked.length} onClick={submit}>Review & grant…</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input autoFocus size="sm" icon={<Search size={12} />} placeholder="Filter roles…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="h-60 overflow-auto rounded-lg border border-border bg-panel p-1">
          {candidates.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-subtle">{filter ? 'No matching roles' : 'No other roles available'}</div>
          ) : (
            candidates.map((r) => (
              <label key={r.name} className={cn('flex h-7 cursor-default items-center gap-2 rounded-md px-2 hover:bg-hover', picked.includes(r.name) && 'bg-accent-soft')}>
                <Checkbox checked={picked.includes(r.name)} onCheckedChange={() => toggle(r.name)} />
                <RoleIcon role={r} size={13} />
                <span className="flex-1 truncate text-[13px]">{r.name}</span>
                {r.isSystem && <span className="text-[10.5px] text-subtle">built-in</span>}
              </label>
            ))
          )}
        </div>
        <div className="flex flex-col gap-1 rounded-lg border border-border p-2">
          <label className="flex items-center gap-2.5 rounded-md px-1 py-1">
            <Checkbox checked={admin} onCheckedChange={setAdmin} />
            <OptionLabel title="With admin option" description="Members can grant / revoke this membership to others" />
          </label>
          {pg16 && (
            <>
              <label className="flex items-center gap-2.5 rounded-md px-1 py-1">
                <Checkbox checked={inherit} onCheckedChange={setInherit} />
                <OptionLabel title="Inherit privileges" description="Unchecked → INHERIT FALSE: privileges only after SET ROLE" />
              </label>
              <label className="flex items-center gap-2.5 rounded-md px-1 py-1">
                <Checkbox checked={setOpt} onCheckedChange={setSetOpt} />
                <OptionLabel title="Allow SET ROLE" description="Unchecked → SET FALSE: member cannot switch to this role" />
              </label>
            </>
          )}
        </div>
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}
