import { Database, FolderTree, FunctionSquare, Hash, Search, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GrantTarget, GrantTargetType, PrivilegeEntry, PrivilegeRequest, RoleInfo, RolesResponse } from '@shared/roles';
import { PRIVILEGES_BY_TARGET, PRIVILEGE_MIN_VERSION } from '@shared/roles';
import { Button, Checkbox, Dialog, Field, Input, Segmented, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rolesApi, runPreviewed, useTargets } from './api';
import { ErrorState, InlineError, OptionLabel, RoleIcon } from './parts';

export interface GrantInitial {
  action: 'grant' | 'revoke';
  /** Prefill type + object from an existing privilege row. */
  fromEntry?: PrivilegeEntry;
}

const TYPES: { value: GrantTargetType; label: string; icon: ReactNode; hint?: string }[] = [
  { value: 'table', label: 'Tables & views', icon: <Table2 size={13} /> },
  { value: 'schema', label: 'Schemas', icon: <FolderTree size={13} /> },
  { value: 'sequence', label: 'Sequences', icon: <Hash size={13} /> },
  { value: 'function', label: 'Functions & procedures', icon: <FunctionSquare size={13} /> },
  { value: 'database', label: 'Databases', icon: <Database size={13} /> },
  { value: 'all_tables', label: 'ALL TABLES in schema', icon: <Table2 size={13} />, hint: 'Existing tables only — future tables need ALTER DEFAULT PRIVILEGES' },
  { value: 'all_sequences', label: 'ALL SEQUENCES in schema', icon: <Hash size={13} />, hint: 'Existing sequences only' },
  { value: 'all_functions', label: 'ALL FUNCTIONS in schema', icon: <FunctionSquare size={13} />, hint: 'Existing functions and procedures only' },
];

const PRIV_HELP: Record<string, string> = {
  SELECT: 'Read rows',
  INSERT: 'Add rows',
  UPDATE: 'Modify rows',
  DELETE: 'Remove rows',
  TRUNCATE: 'Empty the table',
  REFERENCES: 'Create foreign keys',
  TRIGGER: 'Create triggers',
  MAINTAIN: 'VACUUM, ANALYZE…',
  USAGE: 'Look up objects / use',
  CREATE: 'Create objects',
  CONNECT: 'Connect to the database',
  TEMPORARY: 'Create temporary tables',
  EXECUTE: 'Call the routine',
};

function entryType(e: PrivilegeEntry): GrantTargetType {
  switch (e.objectType) {
    case 'database': return 'database';
    case 'schema': return 'schema';
    case 'sequence': return 'sequence';
    case 'function':
    case 'procedure': return 'function';
    default: return 'table';
  }
}

const keyOf = (t: { schema?: string | null; name: string; oid?: number | null }) => (t.oid ? `oid:${t.oid}` : `${t.schema ?? ''}\u0000${t.name}`);

export function GrantDialog({
  connId, db, data, role, initial, onClose,
}: { connId: string; db: string; data: RolesResponse; role: RoleInfo; initial: GrantInitial; onClose: () => void }) {
  const [action, setAction] = useState<'grant' | 'revoke'>(initial.action);
  const [type, setType] = useState<GrantTargetType>(initial.fromEntry ? entryType(initial.fromEntry) : 'table');
  const [picked, setPicked] = useState<Set<string>>(() => (initial.fromEntry ? new Set([keyOf(initial.fromEntry)]) : new Set()));
  const [privs, setPrivs] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [grantOption, setGrantOption] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const targets = useTargets(connId, db, type);
  const available = PRIVILEGES_BY_TARGET[type].filter((p) => !PRIVILEGE_MIN_VERSION[p] || data.versionNum >= PRIVILEGE_MIN_VERSION[p]);

  // Sensible default selections when the type changes.
  const changeType = (t: GrantTargetType) => {
    setType(t);
    setPicked(new Set());
    setPrivs(new Set());
    setAll(false);
    setFilter('');
  };
  useEffect(() => {
    if (type === 'database' && picked.size === 0 && targets.data?.some((t) => t.name === db)) setPicked(new Set([keyOf({ name: db })]));
  }, [type, targets.data, db]);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (targets.data ?? []).filter((t) => !f || t.label.toLowerCase().includes(f));
  }, [targets.data, filter]);

  const allVisiblePicked = list.length > 0 && list.every((t) => picked.has(keyOf(t)));
  const someVisiblePicked = list.some((t) => picked.has(keyOf(t)));
  const toggleAllVisible = () =>
    setPicked((s) => {
      const n = new Set(s);
      if (allVisiblePicked) list.forEach((t) => n.delete(keyOf(t)));
      else list.forEach((t) => n.add(keyOf(t)));
      return n;
    });
  const togglePick = (t: GrantTarget) =>
    setPicked((s) => {
      const n = new Set(s);
      const k = keyOf(t);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  const togglePriv = (p: string) =>
    setPrivs((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p); else n.add(p);
      return n;
    });

  const selectedObjects = (targets.data ?? []).filter((t) => picked.has(keyOf(t)));
  const privList = all ? ['ALL'] : available.filter((p) => privs.has(p));
  const canSubmit = selectedObjects.length > 0 && privList.length > 0;
  const isAllType = type.startsWith('all_');
  const typeInfo = TYPES.find((t) => t.value === type)!;

  const submit = async () => {
    setError(null);
    setBusy(true);
    const req: Omit<PrivilegeRequest, 'dryRun'> = {
      action,
      targetType: type,
      objects: selectedObjects.map((t) => ({ schema: t.schema, name: t.name, oid: t.oid ?? null })),
      privileges: privList,
      grantees: [role.name],
      grantOption,
      cascade: action === 'revoke' && cascade,
    };
    try {
      const ok = await runPreviewed({
        connId,
        db,
        title: action === 'grant' ? 'Grant privileges' : 'Revoke privileges',
        danger: action === 'revoke',
        confirmLabel: action === 'grant' ? 'Grant' : 'Revoke',
        success: `${action === 'grant' ? 'Granted' : 'Revoked'} ${all ? 'all privileges' : privList.join(', ')} on ${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'}`,
        call: (dryRun) => rolesApi.setPrivileges(connId, db, { ...req, dryRun }),
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
      width={640}
      title={action === 'grant' ? 'Grant privileges' : 'Revoke privileges'}
      description={<span className="inline-flex items-center gap-1">In database <b className="font-medium text-fg">{db}</b> {action === 'grant' ? 'to' : 'from'} <RoleIcon role={role} size={12} /> <b className="font-medium text-fg">{role.name}</b></span>}
      footer={
        <>
          <span className="mr-auto text-[11px] text-subtle">
            {selectedObjects.length} object{selectedObjects.length === 1 ? '' : 's'} · {all ? 'ALL PRIVILEGES' : `${privList.length} privilege${privList.length === 1 ? '' : 's'}`}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={action === 'revoke' ? 'danger' : 'primary'} size="md" loading={busy} disabled={!canSubmit} onClick={submit}>
            {action === 'grant' ? 'Review grant…' : 'Review revoke…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Action</span>
            <Segmented
              value={action}
              onChange={setAction}
              options={[
                { value: 'grant', label: 'Grant' },
                { value: 'revoke', label: 'Revoke' },
              ]}
            />
          </div>
          <Field label="Object type" className="flex-1">
            <Select value={type} onChange={(e) => changeType(e.target.value as GrantTargetType)} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
        </div>

        {/* Objects */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">{isAllType ? 'Schemas' : typeInfo.label}</span>
            {typeInfo.hint && <span className="truncate text-[11px] text-subtle">— {typeInfo.hint}</span>}
            <div className="flex-1" />
            <span className="text-[11px] text-subtle tabular-nums">{picked.size} selected</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-panel">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
              <Checkbox
                checked={allVisiblePicked ? true : someVisiblePicked ? 'indeterminate' : false}
                onCheckedChange={toggleAllVisible}
                disabled={!list.length}
              />
              <Input size="sm" icon={<Search size={12} />} placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} className="flex-1" autoFocus />
            </div>
            <div className="h-48 overflow-auto p-1">
              {targets.isLoading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted">Loading…</div>
              ) : targets.error ? (
                <ErrorState error={targets.error} onRetry={() => targets.refetch()} />
              ) : list.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-subtle">{filter ? 'No matches' : 'Nothing found in this database'}</div>
              ) : (
                list.map((t) => (
                  <label
                    key={keyOf(t)}
                    className={cn('flex h-[26px] cursor-default items-center gap-2 rounded-md px-1.5 hover:bg-hover', picked.has(keyOf(t)) && 'bg-accent-soft')}
                  >
                    <Checkbox checked={picked.has(keyOf(t))} onCheckedChange={() => togglePick(t)} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                      {t.schema && <span className="text-subtle">{t.schema}.</span>}
                      <span className="text-fg">{t.schema ? t.label.slice(t.schema.length + 1) : t.label}</span>
                    </span>
                    {t.kind !== 'table' && t.kind !== 'schema' && t.kind !== 'sequence' && t.kind !== 'database' && (
                      <span className="shrink-0 text-[10.5px] text-subtle">{t.kind.replace('_', ' ')}</span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Privileges */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">Privileges</span>
            <div className="flex-1" />
            <label className="flex items-center gap-1.5 text-xs text-fg">
              <Checkbox checked={all} onCheckedChange={setAll} />
              ALL PRIVILEGES
            </label>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {available.map((p) => (
              <label
                key={p}
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                  all || privs.has(p) ? 'border-accent/40 bg-accent-soft' : 'border-border hover:bg-hover',
                  all && 'opacity-70',
                )}
              >
                <Checkbox checked={all || privs.has(p)} disabled={all} onCheckedChange={() => togglePriv(p)} />
                <OptionLabel title={<span className="font-mono text-[12px]">{p}</span>} description={PRIV_HELP[p]} />
              </label>
            ))}
          </div>
        </div>

        {/* Options */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border p-2.5">
          <label className="flex items-center gap-2">
            <Checkbox checked={grantOption} onCheckedChange={setGrantOption} />
            {action === 'grant' ? (
              <OptionLabel title="WITH GRANT OPTION" description="Role may grant these privileges to others" />
            ) : (
              <OptionLabel title="GRANT OPTION FOR only" description="Keep the privileges, revoke only the right to re-grant" />
            )}
          </label>
          {action === 'revoke' && (
            <label className="flex items-center gap-2">
              <Checkbox checked={cascade} onCheckedChange={setCascade} />
              <OptionLabel title="CASCADE" description="Also revoke privileges this role granted onward" />
            </label>
          )}
        </div>

        <InlineError error={error} />
      </div>
    </Dialog>
  );
}
