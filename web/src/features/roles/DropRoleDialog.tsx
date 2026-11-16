import { AlertTriangle, Database, Info, KeyRound, Shield, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DropRoleRequest, RoleInfo, RolesResponse } from '@shared/roles';
import { Badge, Button, Checkbox, Dialog, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rolesApi, runPreviewed, useDependencies } from './api';
import { ErrorState, InlineError, LoadingState, OptionLabel, RoleIcon, sortRoles } from './parts';

export function DropRoleDialog({
  connId, data, role, db: initialDb, databases, onClose, onDropped,
}: {
  connId: string;
  data: RolesResponse;
  role: RoleInfo;
  db: string;
  databases: string[];
  onClose: () => void;
  onDropped: () => void;
}) {
  const [db, setDb] = useState(initialDb);
  const deps = useDependencies(connId, db, role.name);
  const [reassign, setReassign] = useState(false);
  const [reassignTo, setReassignTo] = useState(data.currentUser !== role.name ? data.currentUser : '');
  const [dropOwned, setDropOwned] = useState(false);
  const [dropRole, setDropRole] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const here = deps.data?.perDatabase.find((p) => p.database === db);
  const shared = deps.data?.perDatabase.find((p) => p.database === null);
  const elsewhere = deps.data?.perDatabase.filter((p) => p.database !== null && p.database !== db) ?? [];
  const ownedHere = here?.owned ?? 0;
  const anyHere = (deps.data?.totalInDatabase ?? 0) > 0 || (shared ? shared.privileges + shared.owned : 0) > 0;

  // Pre-select sensible options once dependencies are known.
  useEffect(() => {
    if (!deps.data) return;
    setReassign(ownedHere > 0);
    setDropOwned(anyHere);
  }, [deps.data]);

  const owners = useMemo(() => data.roles.filter((r) => r.name !== role.name && !r.isSystem).sort(sortRoles), [data.roles, role.name]);
  const blocked = elsewhere.length > 0 || (deps.data?.ownedDatabases.length ?? 0) > 0;
  const nothing = !(reassign && reassignTo) && !dropOwned && !dropRole;

  const submit = async () => {
    setError(null);
    setBusy(true);
    const req: Omit<DropRoleRequest, 'dryRun'> = { reassignTo: reassign ? reassignTo : null, dropOwned, dropRole };
    try {
      const ok = await runPreviewed({
        connId,
        db,
        title: dropRole ? `Drop role ${role.name}` : `Clean up ${role.name} in ${db}`,
        danger: true,
        confirmLabel: dropRole ? 'Drop role' : 'Execute',
        message: dropRole ? (
          <>
            This permanently removes <b className="text-fg">{role.name}</b>
            {reassign && reassignTo ? <>; its objects in {db} are first reassigned to <b className="text-fg">{reassignTo}</b></> : dropOwned ? <> and <b className="text-danger">every object it owns in {db}</b></> : ''}
            . This cannot be undone.
          </>
        ) : (
          'Statements run in a single transaction.'
        ),
        success: dropRole ? `Role ${role.name} dropped` : `Owned objects of ${role.name} updated in ${db}`,
        call: (dryRun) => rolesApi.drop(connId, db, role.name, { ...req, dryRun }),
      });
      if (ok) {
        if (dropRole) onDropped();
        else void deps.refetch();
      }
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
      width={600}
      title={<span className="flex items-center gap-2"><RoleIcon role={role} size={15} /> Drop role {role.name}</span>}
      description="Roles that own objects or hold privileges must be cleaned up first, in every database."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="md" loading={busy} disabled={nothing || deps.isLoading || (reassign && !reassignTo)} onClick={submit}>
            {dropRole ? 'Review & drop…' : 'Review…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Database size={13} className="text-subtle" />
          <span className="text-xs text-muted">Database</span>
          <Select size="sm" className="w-52" value={db} onChange={(e) => setDb(e.target.value)} options={(databases.includes(db) ? databases : [db, ...databases]).map((d) => ({ value: d, label: d }))} />
          <span className="text-[11px] text-subtle">REASSIGN / DROP OWNED only affect this database</span>
        </div>

        {/* Dependencies */}
        <div className="overflow-hidden rounded-lg border border-border">
          {deps.isLoading ? (
            <LoadingState label="Checking dependencies…" className="min-h-28" />
          ) : deps.error ? (
            <ErrorState error={deps.error} onRetry={() => deps.refetch()} className="min-h-28" />
          ) : deps.data && (
            <>
              <div className="flex items-center gap-3 border-b border-border bg-panel px-3 py-2 text-xs">
                <span className="font-medium text-fg">In {db}:</span>
                <span className="flex items-center gap-1 text-muted"><Table2 size={12} /> {ownedHere} owned</span>
                <span className="flex items-center gap-1 text-muted"><KeyRound size={12} /> {here?.privileges ?? 0} privileges</span>
                {(here?.policies ?? 0) > 0 && <span className="flex items-center gap-1 text-muted"><Shield size={12} /> {here!.policies} policies</span>}
                {shared && shared.privileges + shared.owned > 0 && (
                  <span className="text-subtle">· {shared.privileges + shared.owned} on databases/tablespaces</span>
                )}
              </div>
              {deps.data.objects.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
                  <Info size={13} className="text-success" /> Nothing in {db} depends on this role.
                </div>
              ) : (
                <div className="max-h-40 overflow-auto py-1">
                  {deps.data.objects.map((o, i) => (
                    <div key={i} className="flex h-6 items-center gap-2 px-3 text-xs">
                      <Badge tone={o.kind === 'owner' ? 'warning' : o.kind === 'policy' ? 'accent' : 'neutral'} className="w-16 justify-center">{o.kind}</Badge>
                      <span className="truncate font-mono text-[11.5px] text-fg">{o.description}</span>
                    </div>
                  ))}
                  {deps.data.totalInDatabase > deps.data.objects.length && (
                    <div className="px-3 py-1 text-[11px] text-subtle">…and {deps.data.totalInDatabase - deps.data.objects.length} more</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {blocked && deps.data && (
          <div className="flex gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-fg">
            <AlertTriangle size={14} className="mt-px shrink-0 text-warning" />
            <div className="flex flex-col gap-1">
              {elsewhere.length > 0 && (
                <div>
                  Also has dependencies in other databases — switch the database above and clean up each before dropping:
                  <div className="mt-1 flex flex-wrap gap-1">
                    {elsewhere.map((p) => (
                      <button key={p.database} onClick={() => setDb(p.database!)} className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[11px] hover:border-accent">
                        {p.database} <span className="text-subtle">({p.owned} owned, {p.privileges} priv.)</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {deps.data.ownedDatabases.length > 0 && (
                <div>Owns database{deps.data.ownedDatabases.length > 1 ? 's' : ''} <b>{deps.data.ownedDatabases.join(', ')}</b> — reassign ownership first (REASSIGN OWNED from that database, or ALTER DATABASE … OWNER TO).</div>
              )}
            </div>
          </div>
        )}

        {/* Steps */}
        <div className="flex flex-col gap-1 rounded-lg border border-border p-2">
          <div className="flex items-center gap-2.5 rounded-md px-1 py-1">
            <Checkbox checked={reassign} onCheckedChange={setReassign} />
            <OptionLabel title={<>1. <code className="font-mono text-[12px]">REASSIGN OWNED BY</code> {role.name} to</>} description="Transfer ownership of its objects in this database (and shared objects)" />
            <Select
              size="sm"
              className={cn('ml-auto w-44', !reassign && 'opacity-50')}
              disabled={!reassign}
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              options={[{ value: '', label: 'Choose a role…' }, ...owners.map((r) => ({ value: r.name, label: r.name === data.currentUser ? `${r.name} (you)` : r.name }))]}
            />
          </div>
          <label className="flex items-center gap-2.5 rounded-md px-1 py-1">
            <Checkbox checked={dropOwned} onCheckedChange={setDropOwned} />
            <OptionLabel
              title={<>2. <code className="font-mono text-[12px]">DROP OWNED BY</code> {role.name}</>}
              description={reassign ? 'Revokes its remaining privileges (owned objects were reassigned)' : <span className="text-danger">Drops every object it owns in this database and revokes its privileges</span>}
            />
          </label>
          <label className="flex items-center gap-2.5 rounded-md px-1 py-1">
            <Checkbox checked={dropRole} onCheckedChange={setDropRole} />
            <OptionLabel title={<>3. <code className="font-mono text-[12px]">DROP ROLE</code> {role.name}</>} description="Uncheck to only clean up this database (e.g. before visiting the next one)" />
          </label>
        </div>

        <InlineError error={error} />
      </div>
    </Dialog>
  );
}
