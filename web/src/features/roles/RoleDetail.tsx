import { Copy, FileCode2, KeyRound, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { RoleInfo, RoleSpec, RolesResponse } from '@shared/roles';
import { Button, DropdownMenu, IconButton, Segmented, Switch, Toolbar, Tooltip, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useWorkspace } from '@/stores/workspace';
import { rolesApi, runPreviewed, toastError } from './api';
import { MembershipPanel } from './Membership';
import { ATTRIBUTES, RoleBadges, RoleIcon, SectionTitle, expiryInfo, roleKindLabel } from './parts';
import { PrivilegesPanel } from './Privileges';

export type Section = 'attributes' | 'memberOf' | 'members' | 'privileges';

interface Props {
  connId: string;
  data: RolesResponse;
  role: RoleInfo;
  section: Section;
  onSection: (s: Section) => void;
  db: string;
  databases: string[];
  onDbChange: (db: string) => void;
  onEdit: () => void;
  onDrop: () => void;
  onNavigate: (name: string) => void;
}

/** CREATE ROLE script for an existing role (password omitted), built by the server's dry-run. */
async function createScript(connId: string, role: RoleInfo): Promise<string> {
  const spec: RoleSpec = {
    name: role.name,
    canLogin: role.canLogin,
    superuser: role.superuser,
    createDb: role.createDb,
    createRole: role.createRole,
    inherit: role.inherit,
    replication: role.replication,
    bypassRls: role.bypassRls,
    connLimit: role.connLimit,
    validUntil: role.validUntil === 'infinity' ? null : role.validUntil,
    comment: role.comment,
    memberOf: role.memberOf.map((m) => m.role),
  };
  const r = await rolesApi.create(connId, { spec, dryRun: true });
  return `-- Role ${role.name}${role.hasPassword ? ' (password not included)' : ''}\n${r.sql}\n`;
}

export function RoleDetail(p: Props) {
  const { connId, data, role, section } = p;
  const isYou = role.name === data.currentUser;
  const editable = !role.isSystem && data.canCreateRole && (!role.superuser || data.isSuperuser);
  const droppable = editable && !isYou;

  const copyDdl = async (open: boolean) => {
    try {
      const sql = await createScript(connId, role);
      if (open) {
        useWorkspace.getState().newQuery({ connId, database: p.db, sql, title: `Role ${role.name}` });
      } else {
        await navigator.clipboard.writeText(sql);
        toast.success('CREATE ROLE script copied');
      }
    } catch (e) {
      toastError(e, 'Could not generate script');
    }
  };

  const subtitle: string[] = [roleKindLabel(role)];
  if (role.memberOf.length) subtitle.push(`member of ${role.memberOf.length}`);
  if (role.members.length) subtitle.push(`${role.members.length} member${role.members.length === 1 ? '' : 's'}`);
  subtitle.push(`OID ${role.oid}`);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 pt-4 pb-3.5">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-border',
            role.superuser ? 'bg-warning-soft' : role.isSystem ? 'bg-sunken' : role.canLogin ? 'bg-accent-soft' : 'bg-[color-mix(in_srgb,var(--info)_12%,transparent)]',
          )}
        >
          <RoleIcon role={role} size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="truncate text-[17px] font-semibold tracking-tight text-fg select-text">{role.name}</h2>
            <RoleBadges role={role} isYou={isYou} />
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {subtitle.join(' · ')}
            {role.comment && <span className="text-subtle"> — {role.comment}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip content={editable ? 'Edit attributes, password and comment' : role.isSystem ? 'Built-in roles cannot be edited' : 'You lack the privilege to edit this role'}>
            <span>
              <Button size="sm" variant="outline" icon={<Pencil size={13} />} onClick={p.onEdit} disabled={!editable}>Edit</Button>
            </span>
          </Tooltip>
          <Tooltip content={droppable ? 'Drop this role' : isYou ? 'You cannot drop the role you are connected as' : role.isSystem ? 'Built-in roles cannot be dropped' : 'You lack the privilege to drop this role'}>
            <span>
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" icon={<Trash2 size={13} />} onClick={p.onDrop} disabled={!droppable}>
                Drop…
              </Button>
            </span>
          </Tooltip>
          <DropdownMenu
            align="end"
            trigger={<IconButton label="More actions"><MoreHorizontal size={15} /></IconButton>}
            items={[
              { label: 'Copy CREATE ROLE script', icon: <Copy size={13} />, onSelect: () => void copyDdl(false) },
              { label: 'Open script in SQL editor', icon: <FileCode2 size={13} />, onSelect: () => void copyDdl(true) },
              'separator',
              { label: 'Copy role name', icon: <Copy size={13} />, onSelect: () => { void navigator.clipboard.writeText(role.name); toast.success('Copied'); } },
            ]}
          />
        </div>
      </div>

      <Toolbar className="px-4">
        <Segmented<Section>
          value={section}
          onChange={p.onSection}
          options={[
            { value: 'attributes', label: 'Attributes' },
            { value: 'memberOf', label: <>Member of <Count n={role.memberOf.length} /></> },
            { value: 'members', label: <>Members <Count n={role.members.length} /></> },
            { value: 'privileges', label: 'Privileges' },
          ]}
        />
      </Toolbar>

      <div className="min-h-0 flex-1">
        {section === 'attributes' && <AttributesPanel connId={connId} data={data} role={role} editable={editable} onEdit={p.onEdit} />}
        {section === 'memberOf' && <MembershipPanel connId={connId} data={data} role={role} mode="memberOf" onNavigate={p.onNavigate} />}
        {section === 'members' && <MembershipPanel connId={connId} data={data} role={role} mode="members" onNavigate={p.onNavigate} />}
        {section === 'privileges' && (
          <PrivilegesPanel connId={connId} data={data} role={role} db={p.db} databases={p.databases} onDbChange={p.onDbChange} />
        )}
      </div>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className={cn('tabular-nums', n ? 'text-subtle' : 'text-subtle/60')}>{n}</span>;
}

// ---------------------------------------------------------------- attributes

function AttributesPanel({ connId, data, role, editable, onEdit }: { connId: string; data: RolesResponse; role: RoleInfo; editable: boolean; onEdit: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const exp = expiryInfo(role.validUntil);

  /** Quick toggle: ALTER ROLE with a single attribute, previewed first. */
  const toggle = async (key: (typeof ATTRIBUTES)[number]['key'], value: boolean) => {
    const a = ATTRIBUTES.find((x) => x.key === key)!;
    setPending(key);
    try {
      await runPreviewed({
        connId,
        title: `${value ? 'Enable' : 'Disable'} ${a.label.toLowerCase()}`,
        success: `${role.name}: ${value ? a.sql[0] : a.sql[1]}`,
        danger: key === 'superuser' && value,
        message: key === 'superuser' && value ? 'A superuser bypasses every permission check, including row-level security.' : undefined,
        confirmLabel: 'Apply',
        call: (dryRun) => rolesApi.alter(connId, role.name, { spec: { name: role.name, [key]: value }, dryRun }),
      });
    } catch (e) {
      toastError(e, 'Could not change attribute');
    } finally {
      setPending(null);
    }
  };

  const pw: ReactNode =
    role.hasPassword === null ? (
      <span className="text-subtle">Unknown <span className="text-[11px]">(requires superuser)</span></span>
    ) : role.hasPassword ? (
      <span className="flex items-center gap-1.5"><KeyRound size={12} className="text-success" /> Set{role.passwordType && <span className="text-[11px] text-subtle uppercase">{role.passwordType}</span>}</span>
    ) : (
      <span className="text-muted">Not set</span>
    );

  return (
    <div className="h-full overflow-auto">
      <div className="grid max-w-5xl grid-cols-1 gap-6 p-5 lg:grid-cols-2">
        <section>
          <SectionTitle>Role attributes</SectionTitle>
          <div className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
            {ATTRIBUTES.map((a) => {
              const locked = !editable || (a.superuserOnly && !data.isSuperuser);
              const on = role[a.key];
              return (
                <div key={a.key} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13px]', on ? 'text-fg' : 'text-muted')}>{a.label}</div>
                    <div className="text-[11px] leading-snug text-subtle">{a.description}</div>
                  </div>
                  <code className={cn('hidden font-mono text-[10.5px] xl:inline', on ? 'text-success' : 'text-subtle')}>{on ? a.sql[0] : a.sql[1]}</code>
                  <Tooltip content={locked ? (role.isSystem ? 'Built-in role' : 'Requires superuser') : `Toggle ${on ? a.sql[1] : a.sql[0]}`}>
                    <span>
                      <Switch checked={on} disabled={locked || pending !== null} onCheckedChange={(v) => void toggle(a.key, v)} />
                    </span>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col gap-6">
          <section>
            <SectionTitle right={editable && <Button size="xs" variant="ghost" icon={<Pencil size={11} />} onClick={onEdit}>Edit</Button>}>
              Login & limits
            </SectionTitle>
            <dl className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel text-[13px]">
              <Prop label="Password">{pw}</Prop>
              <Prop label="Valid until">
                <span className={cn(exp.expired ? 'text-danger' : exp.never ? 'text-muted' : 'text-fg')}>
                  {exp.text}
                  {exp.expired && ' (expired)'}
                </span>
              </Prop>
              <Prop label="Connection limit">
                {role.connLimit < 0 ? <span className="text-muted">Unlimited</span> : <span className="tabular-nums">{formatCount(role.connLimit)}</span>}
              </Prop>
              <Prop label="OID"><span className="font-mono text-xs text-muted">{role.oid}</span></Prop>
            </dl>
          </section>

          <section>
            <SectionTitle right={editable && <Button size="xs" variant="ghost" icon={<Pencil size={11} />} onClick={onEdit}>Edit</Button>}>
              Comment
            </SectionTitle>
            <div className={cn('mt-1 rounded-lg border border-border bg-panel px-3 py-2.5 text-[13px] whitespace-pre-wrap', !role.comment && 'text-subtle italic')}>
              {role.comment || 'No comment'}
            </div>
          </section>

          <section>
            <SectionTitle>Session defaults</SectionTitle>
            {role.config.length === 0 ? (
              <div className="mt-1 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-subtle">
                No role-specific settings (<code className="font-mono">ALTER ROLE … SET</code>)
              </div>
            ) : (
              <div className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
                {role.config.map((c) => {
                  const i = c.indexOf('=');
                  return (
                    <div key={c} className="flex gap-3 px-3 py-1.5 font-mono text-xs">
                      <span className="text-syntax-keyword">{i > 0 ? c.slice(0, i) : c}</span>
                      <span className="truncate text-fg">{i > 0 ? c.slice(i + 1) : ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-3 px-3">
      <dt className="w-32 shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  );
}
