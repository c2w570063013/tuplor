import { Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState } from '@/components/ui';
import { useConnections } from '@/stores/connections';
import { useWorkspace } from '@/stores/workspace';
import type { TabProps } from '../common/TabProps';
import { useRoles } from './api';
import { DropRoleDialog } from './DropRoleDialog';
import { ErrorState, LoadingState } from './parts';
import { RoleDialog } from './RoleDialog';
import { RoleDetail, type Section } from './RoleDetail';
import { RoleList } from './RoleList';

/**
 * Roles & Users tab (kind 'roles').
 * params: { role?: string, section?: Section, privDb?: string }
 * Roles are cluster-wide; the privileges view and drop clean-up work on one database at a time.
 */
export default function RolesTab({ tab }: TabProps) {
  const connId = tab.connId!;
  const params = tab.params as { role?: string; section?: Section; privDb?: string };
  const q = useRoles(connId);
  const [dialog, setDialog] = useState<null | { kind: 'create' } | { kind: 'edit'; role: string } | { kind: 'drop'; role: string }>(null);

  const connState = useConnections((s) => s.state[connId]);
  useEffect(() => {
    if (!connState || connState.status === 'idle') useConnections.getState().connect(connId).catch(() => {});
  }, [connId, connState?.status]);

  const databases = useMemo(
    () => (connState?.info?.databases ?? []).filter((d) => !d.isTemplate && d.allowConn).map((d) => d.name),
    [connState?.info],
  );
  const db = params.privDb || tab.database || databases[0] || 'postgres';

  const update = (patch: Record<string, unknown>) => useWorkspace.getState().updateParams(tab.id, patch);
  const select = (role: string) => update({ role });

  const roles = q.data?.roles;
  const selected = roles?.find((r) => r.name === params.role);

  // Default / fallback selection: the requested role, else the current user, else the first non-system role.
  useEffect(() => {
    if (!roles || selected) return;
    const fallback = roles.find((r) => r.name === q.data!.currentUser && !r.isSystem) ?? roles.find((r) => !r.isSystem) ?? roles[0];
    if (fallback) select(fallback.name);
  }, [roles, selected]);

  const section: Section = params.section ?? 'attributes';
  const dialogRole = dialog && dialog.kind !== 'create' ? roles?.find((r) => r.name === dialog.role) : undefined;

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-panel">
        <RoleList
          data={q.data}
          isLoading={q.isLoading}
          isFetching={q.isFetching}
          error={q.error}
          selected={selected?.name}
          onSelect={select}
          onCreate={() => setDialog({ kind: 'create' })}
          onRefresh={() => void q.refetch()}
        />
      </aside>
      <main className="min-w-0 flex-1">
        {q.isLoading ? (
          <LoadingState label="Loading roles…" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load roles" />
        ) : !selected || !q.data ? (
          <EmptyState
            icon={<ShieldCheck size={28} />}
            title="No role selected"
            description="Pick a role on the left to see its attributes, memberships and privileges."
            action={q.data?.canCreateRole && <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setDialog({ kind: 'create' })}>New role</Button>}
          />
        ) : (
          <RoleDetail
            key={selected.name}
            connId={connId}
            data={q.data}
            role={selected}
            section={section}
            onSection={(s) => update({ section: s })}
            db={db}
            databases={databases}
            onDbChange={(d) => update({ privDb: d })}
            onEdit={() => setDialog({ kind: 'edit', role: selected.name })}
            onDrop={() => setDialog({ kind: 'drop', role: selected.name })}
            onNavigate={select}
          />
        )}
      </main>

      {q.data && dialog?.kind === 'create' && (
        <RoleDialog
          connId={connId}
          data={q.data}
          onClose={() => setDialog(null)}
          onSaved={(name) => { setDialog(null); select(name); }}
        />
      )}
      {q.data && dialog?.kind === 'edit' && dialogRole && (
        <RoleDialog
          connId={connId}
          data={q.data}
          role={dialogRole}
          onClose={() => setDialog(null)}
          onSaved={(name) => { setDialog(null); select(name); }}
        />
      )}
      {q.data && dialog?.kind === 'drop' && dialogRole && (
        <DropRoleDialog
          connId={connId}
          data={q.data}
          role={dialogRole}
          db={db}
          databases={databases}
          onClose={() => setDialog(null)}
          onDropped={() => { setDialog(null); update({ role: undefined }); }}
        />
      )}
    </div>
  );
}
