import { useQuery } from '@tanstack/react-query';
import type {
  DropRoleRequest, GrantTarget, GrantTargetType, MembershipRequest, PrivilegeRequest, PrivilegesResponse,
  RoleDependencies, RoleMutationRequest, RolesResponse, SqlResult,
} from '@shared/roles';
import { toast } from '@/components/ui';
import { ApiError, dbUrl, http } from '@/lib/api';
import { invalidateDb, queryClient } from '@/lib/queryClient';
import { confirmSql } from '@/stores/dialogs';
import type { ReactNode } from 'react';

const enc = encodeURIComponent;
const srv = (connId: string) => `/api/c/${enc(connId)}/roles`;
const dbr = (connId: string, db: string) => `${dbUrl(connId, db)}/roles`;

export const rolesApi = {
  list: (connId: string) => http.get<RolesResponse>(srv(connId)),
  create: (connId: string, body: RoleMutationRequest) => http.post<SqlResult>(srv(connId), body),
  alter: (connId: string, name: string, body: RoleMutationRequest) => http.put<SqlResult>(`${srv(connId)}/${enc(name)}`, body),
  membership: (connId: string, body: MembershipRequest) => http.post<SqlResult>(`${srv(connId)}/membership`, body),
  targets: (connId: string, db: string, type: GrantTargetType) => http.get<GrantTarget[]>(`${dbr(connId, db)}/targets?type=${enc(type)}`),
  privileges: (connId: string, db: string, role: string) => http.get<PrivilegesResponse>(`${dbr(connId, db)}/${enc(role)}/privileges`),
  setPrivileges: (connId: string, db: string, body: PrivilegeRequest) => http.post<SqlResult>(`${dbr(connId, db)}/privileges`, body),
  dependencies: (connId: string, db: string, role: string) => http.get<RoleDependencies>(`${dbr(connId, db)}/${enc(role)}/dependencies`),
  drop: (connId: string, db: string, role: string, body: DropRoleRequest) => http.post<SqlResult>(`${dbr(connId, db)}/${enc(role)}/drop`, body),
};

// ---------------------------------------------------------------- query hooks

export const roleKeys = {
  all: (connId: string) => ['roles', connId] as const,
  list: (connId: string) => ['roles', connId, 'list'] as const,
  privileges: (connId: string, db: string, role: string) => ['roles', connId, 'privileges', db, role] as const,
  deps: (connId: string, db: string, role: string) => ['roles', connId, 'deps', db, role] as const,
  targets: (connId: string, db: string, type: GrantTargetType) => ['roles', connId, 'targets', db, type] as const,
};

export function useRoles(connId: string) {
  return useQuery({ queryKey: roleKeys.list(connId), queryFn: () => rolesApi.list(connId), staleTime: 10_000 });
}

export function usePrivileges(connId: string, db: string | undefined, role: string | undefined) {
  return useQuery({
    queryKey: roleKeys.privileges(connId, db ?? '', role ?? ''),
    queryFn: () => rolesApi.privileges(connId, db!, role!),
    enabled: !!db && !!role,
    staleTime: 10_000,
  });
}

export function useDependencies(connId: string, db: string, role: string, enabled = true) {
  return useQuery({
    queryKey: roleKeys.deps(connId, db, role),
    queryFn: () => rolesApi.dependencies(connId, db, role),
    enabled,
    staleTime: 0,
  });
}

export function useTargets(connId: string, db: string, type: GrantTargetType, enabled = true) {
  return useQuery({ queryKey: roleKeys.targets(connId, db, type), queryFn: () => rolesApi.targets(connId, db, type), enabled });
}

export function invalidateRoles(connId: string) {
  return queryClient.invalidateQueries({ queryKey: roleKeys.all(connId) });
}

// ---------------------------------------------------------------- helpers

export function errorInfo(e: unknown): { message: string; detail?: string; hint?: string } {
  if (e instanceof ApiError) return { message: e.info.message, detail: e.info.detail, hint: e.info.hint };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

export function toastError(e: unknown, title?: string) {
  const i = errorInfo(e);
  toast.error(title ?? i.message, { description: title ? i.message : i.hint ?? i.detail });
}

/**
 * The standard mutation flow: ask the server for the SQL (dryRun), show it with confirmSql,
 * then execute, toast and invalidate caches. Returns true when executed.
 * Throws ApiError on failure (the caller decides how to show it).
 */
export async function runPreviewed(o: {
  connId: string;
  title: string;
  call: (dryRun: boolean) => Promise<SqlResult>;
  success: string;
  message?: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  /** database whose explorer caches should refresh (ownership / DDL changes) */
  db?: string;
}): Promise<boolean> {
  const preview = await o.call(true);
  if (!preview.sql.trim()) {
    toast.info('Nothing to change');
    return false;
  }
  const ok = await confirmSql({ title: o.title, sql: preview.sql, message: o.message, danger: o.danger, confirmLabel: o.confirmLabel });
  if (!ok) return false;
  await o.call(false);
  toast.success(o.success);
  await invalidateRoles(o.connId);
  if (o.db) invalidateDb(o.connId, o.db);
  return true;
}
