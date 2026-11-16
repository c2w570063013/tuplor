import { Eye, EyeOff, Plus, User, Users, Wand2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RoleInfo, RoleSpec, RolesResponse } from '@shared/roles';
import { Button, Checkbox, Dialog, Field, IconButton, Input, Segmented, Select, Switch, Textarea, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rolesApi, runPreviewed } from './api';
import { ATTRIBUTES, InlineError, OptionLabel, RoleIcon, SectionTitle, generatePassword, sortRoles } from './parts';

interface Props {
  connId: string;
  data: RolesResponse;
  /** undefined = create a new role */
  role?: RoleInfo;
  onClose: () => void;
  onSaved: (name: string) => void;
}

type Attrs = Record<(typeof ATTRIBUTES)[number]['key'], boolean>;

/** ISO / PG timestamp -> value for <input type="datetime-local"> (local time). */
function toLocalInput(v: string | null): string {
  if (!v || v === 'infinity' || v === '-infinity') return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function RoleDialog({ connId, data, role, onClose, onSaved }: Props) {
  const editing = !!role;
  const [name, setName] = useState(role?.name ?? '');
  const [attrs, setAttrs] = useState<Attrs>(() => ({
    canLogin: role?.canLogin ?? true,
    superuser: role?.superuser ?? false,
    createDb: role?.createDb ?? false,
    createRole: role?.createRole ?? false,
    inherit: role?.inherit ?? true,
    replication: role?.replication ?? false,
    bypassRls: role?.bypassRls ?? false,
  }));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  const initialExpiry = toLocalInput(role?.validUntil ?? null);
  const [expires, setExpires] = useState(!!initialExpiry);
  const [validUntil, setValidUntil] = useState(initialExpiry);
  const [connLimit, setConnLimit] = useState(role && role.connLimit >= 0 ? String(role.connLimit) : '');
  const [comment, setComment] = useState(role?.comment ?? '');
  const [memberOf, setMemberOf] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const otherRoles = useMemo(
    () => data.roles.filter((r) => r.name !== role?.name && !memberOf.includes(r.name)).sort((a, b) => Number(a.isSystem) - Number(b.isSystem) || sortRoles(a, b)),
    [data.roles, role, memberOf],
  );

  const connLimitNum = connLimit.trim() === '' ? -1 : Number(connLimit);
  const connLimitInvalid = !Number.isInteger(connLimitNum) || connLimitNum < -1;
  const nameInvalid = !name.trim();
  const expiryInvalid = expires && !validUntil;

  const buildSpec = (): RoleSpec => {
    const spec: RoleSpec = {
      name: name,
      ...attrs,
      connLimit: connLimitNum,
      validUntil: expires && validUntil ? new Date(validUntil).toISOString() : null,
      comment: comment.trim() ? comment : null,
    };
    if (password) spec.password = password;
    else if (editing && removePassword) spec.removePassword = true;
    if (!editing && memberOf.length) spec.memberOf = memberOf;
    // Keep unchanged expiry untouched when editing (avoids rewriting an identical timestamp).
    if (editing && toLocalInput(role!.validUntil) === (expires ? validUntil : '')) delete spec.validUntil;
    return spec;
  };

  const submit = async () => {
    if (nameInvalid || connLimitInvalid || expiryInvalid) return;
    setError(null);
    setBusy(true);
    try {
      const spec = buildSpec();
      const ok = await runPreviewed({
        connId,
        title: editing ? `Alter role ${role!.name}` : 'Create role',
        call: (dryRun) => (editing ? rolesApi.alter(connId, role!.name, { spec, dryRun }) : rolesApi.create(connId, { spec, dryRun })),
        success: editing ? `Role ${spec.name} updated` : `Role ${spec.name} created`,
        confirmLabel: editing ? 'Apply changes' : 'Create role',
        message: password ? 'The password is masked in this preview and never shown again.' : undefined,
      });
      if (ok) onSaved(spec.name);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const su = data.isSuperuser;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={620}
      title={editing ? <span className="flex items-center gap-2"><RoleIcon role={role!} size={15} /> Edit role {role!.name}</span> : 'New role'}
      description={editing ? 'Change attributes, password or comment. Only modified settings are applied.' : 'Create a login user or a group role.'}
      footer={
        <>
          <span className="mr-auto text-[11px] text-subtle">You’ll review the SQL before it runs.</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" loading={busy} disabled={nameInvalid || connLimitInvalid || expiryInvalid} onClick={submit}>
            {editing ? 'Review changes…' : 'Review & create…'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* General */}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Role name">
            <Input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. app_readonly" spellCheck={false} maxLength={63} />
          </Field>
          <div className="pb-1">
            <Segmented
              value={attrs.canLogin ? 'user' : 'group'}
              onChange={(v) => setAttrs((a) => ({ ...a, canLogin: v === 'user' }))}
              options={[
                { value: 'user', label: 'User', icon: <User size={12} /> },
                { value: 'group', label: 'Group', icon: <Users size={12} /> },
              ]}
            />
          </div>
        </div>

        {/* Authentication */}
        <section className="flex flex-col gap-3">
          <SectionTitle>Authentication</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Password"
              hint={editing ? (role!.hasPassword === false ? 'No password set' : 'Leave empty to keep the current password') : !attrs.canLogin ? 'Group roles usually have no password' : undefined}
            >
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={removePassword}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editing ? '•••••••• unchanged' : 'Optional'}
                  className="pr-14"
                  mono={showPassword && !!password}
                />
                <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
                  <IconButton label="Generate a strong password" size="xs" type="button" disabled={removePassword} onClick={() => { setPassword(generatePassword()); setShowPassword(true); }}>
                    <Wand2 size={12} />
                  </IconButton>
                  <IconButton label={showPassword ? 'Hide password' : 'Show password'} size="xs" type="button" onClick={() => setShowPassword((s) => !s)}>
                    {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                  </IconButton>
                </div>
              </div>
            </Field>
            <Field label="Connection limit" hint="Empty or -1 = unlimited">
              <Input
                type="number"
                min={-1}
                value={connLimit}
                onChange={(e) => setConnLimit(e.target.value)}
                placeholder="Unlimited"
                className={cn(connLimitInvalid && 'border-danger')}
              />
            </Field>
          </div>
          {editing && role!.hasPassword !== false && (
            <label className="flex w-fit items-center gap-2 text-xs text-muted">
              <Checkbox checked={removePassword} onCheckedChange={(v) => { setRemovePassword(v); if (v) setPassword(''); }} />
              Remove password (<code className="font-mono text-[11px]">PASSWORD NULL</code>) — password login will no longer work
            </label>
          )}
          <div className="flex items-center gap-3">
            <label className="flex shrink-0 items-center gap-2 text-[13px] whitespace-nowrap text-fg">
              <Switch checked={expires} onCheckedChange={(v) => { setExpires(v); if (v && !validUntil) setValidUntil(toLocalInput(new Date(Date.now() + 90 * 864e5).toISOString())); }} />
              Password expires
            </label>
            <Input
              type="datetime-local"
              value={validUntil}
              disabled={!expires}
              onChange={(e) => setValidUntil(e.target.value)}
              className={cn('w-56', expiryInvalid && 'border-danger')}
            />
            {!expires && <span className="text-[11px] text-subtle">Never (VALID UNTIL 'infinity')</span>}
          </div>
        </section>

        {/* Attributes */}
        <section className="flex flex-col gap-2">
          <SectionTitle>Attributes</SectionTitle>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border bg-panel p-2">
            {ATTRIBUTES.filter((a) => a.key !== 'canLogin').map((a) => {
              const locked = a.superuserOnly && !su;
              const row = (
                <label
                  key={a.key}
                  className={cn('flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover', locked && 'opacity-50')}
                >
                  <OptionLabel title={a.label} description={a.description} />
                  <span className="ml-auto">
                    <Switch checked={attrs[a.key]} disabled={locked} onCheckedChange={(v) => setAttrs((s) => ({ ...s, [a.key]: v }))} />
                  </span>
                </label>
              );
              return locked ? (
                <Tooltip key={a.key} content="Only superusers can change this attribute">
                  {row}
                </Tooltip>
              ) : (
                row
              );
            })}
          </div>
        </section>

        {/* Membership (create only) */}
        {!editing && (
          <section className="flex flex-col gap-2">
            <SectionTitle>Member of</SectionTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              {memberOf.map((m) => (
                <span key={m} className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-panel pr-0.5 pl-2 text-xs text-fg">
                  {m}
                  <button type="button" className="rounded p-0.5 text-subtle hover:bg-hover hover:text-fg" onClick={() => setMemberOf((l) => l.filter((x) => x !== m))} aria-label={`Remove ${m}`}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              <Select
                size="sm"
                className="w-48"
                value=""
                onChange={(e) => e.target.value && setMemberOf((l) => [...l, e.target.value])}
                options={[{ value: '', label: memberOf.length ? 'Add another role…' : 'Add to role…' }, ...otherRoles.map((r) => ({ value: r.name, label: r.isSystem ? `${r.name} (built-in)` : r.name }))]}
              />
              {memberOf.length === 0 && <span className="flex items-center gap-1 text-[11px] text-subtle"><Plus size={11} /> Inherit privileges by joining group roles</span>}
            </div>
          </section>
        )}

        {/* Comment */}
        <Field label="Comment">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What is this role for?" className="resize-none" />
        </Field>

        <InlineError error={error} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
