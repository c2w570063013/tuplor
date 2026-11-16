import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  ApplyResponse, ExtensionInfo, ObjectDetails, TableDetails, TypeSuggestion,
} from '@shared/schema';
import { toast } from '@/components/ui';
import { ApiError, dbUrl, http } from '@/lib/api';
import { invalidateDb, queryClient } from '@/lib/queryClient';
import { confirmSql } from '@/stores/dialogs';

/**
 * Client for the Explorer & Structure endpoints (server/src/routes/schema.ts).
 *
 * Query keys start with ['objects', connId, db, …] so the core `invalidateDb(connId, db)`
 * refreshes them too after any DDL.
 */
const enc = encodeURIComponent;

export const schemaKeys = {
  table: (c: string, d: string, s: string, t: string) => ['objects', c, d, s, '~table', t] as const,
  object: (c: string, d: string, kind: string, oid: number) => ['objects', c, d, '~object', kind, oid] as const,
  ddl: (c: string, d: string, s: string, t: string) => ['objects', c, d, s, '~ddl', t] as const,
  extensions: (c: string, d: string) => ['objects', c, d, '~extensions'] as const,
  types: (c: string, d: string) => ['objects', c, d, '~types'] as const,
};

export const schemaApi = {
  table: (c: string, d: string, s: string, t: string) =>
    http.get<TableDetails>(`${dbUrl(c, d)}/schema/tables/${enc(s)}/${enc(t)}`),
  tableDdl: (c: string, d: string, s: string, t: string) =>
    http.get<{ ddl: string }>(`${dbUrl(c, d)}/schema/tables/${enc(s)}/${enc(t)}/ddl`).then((r) => r.ddl),
  object: (c: string, d: string, kind: string, oid: number) =>
    http.get<ObjectDetails>(`${dbUrl(c, d)}/schema/objects/${enc(kind)}/${oid}`),
  resolve: (c: string, d: string, schema: string, name: string, kind: string) =>
    http.get<{ oid: number }>(`${dbUrl(c, d)}/schema/resolve?schema=${enc(schema)}&name=${enc(name)}&kind=${enc(kind)}`).then((r) => r.oid),
  extensions: (c: string, d: string) => http.get<ExtensionInfo[]>(`${dbUrl(c, d)}/schema/extensions`),
  types: (c: string, d: string) => http.get<TypeSuggestion[]>(`${dbUrl(c, d)}/schema/types`),
  apply: (c: string, d: string, statements: string[], transaction = true) =>
    http.post<ApplyResponse>(`${dbUrl(c, d)}/schema/apply`, { statements, transaction }),
};

export function useTableDetails(connId: string, db: string, schema: string, table: string, enabled = true) {
  return useQuery({
    queryKey: schemaKeys.table(connId, db, schema, table),
    queryFn: () => schemaApi.table(connId, db, schema, table),
    enabled,
  });
}

export function useTypeSuggestions(connId: string, db: string) {
  return useQuery({ queryKey: schemaKeys.types(connId, db), queryFn: () => schemaApi.types(connId, db), staleTime: 120_000 });
}

/** Human readable error message for toasts (message + hint/detail). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const extra = e.info.detail || e.info.hint;
    const idx = e.info.statementIndex != null ? ` (statement ${e.info.statementIndex + 1})` : '';
    return e.info.message + idx + (extra ? ` — ${extra}` : '');
  }
  return e instanceof Error ? e.message : String(e);
}

/** Join statements into a script (each terminated with a semicolon). */
export function toScript(statements: string[]): string {
  return statements.map((s) => s.trim().replace(/;\s*$/, '') + ';').join('\n');
}

export interface RunDdlOptions {
  connId: string;
  db: string;
  title: string;
  statements: string[];
  message?: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  /** Toast shown on success. */
  success: string;
  /** Run in one transaction (default true). */
  transaction?: boolean;
  /** Skip the SQL preview (only for non-destructive, already-confirmed actions). */
  skipConfirm?: boolean;
  /** Also refresh the connection's server info (database-level changes). */
  refreshConnection?: boolean;
}

/**
 * Preview SQL via confirmSql, execute (in a transaction), toast, and invalidate caches.
 * Returns true when executed successfully. Errors are toasted and re-thrown as `false`.
 */
export async function runDdl(o: RunDdlOptions): Promise<boolean> {
  if (!o.skipConfirm) {
    const ok = await confirmSql({ title: o.title, sql: toScript(o.statements), message: o.message, danger: o.danger, confirmLabel: o.confirmLabel });
    if (!ok) return false;
  }
  try {
    await schemaApi.apply(o.connId, o.db, o.statements, o.transaction ?? true);
  } catch (e) {
    toast.error(errorText(e), { duration: 8000 });
    return false;
  }
  toast.success(o.success);
  invalidateDb(o.connId, o.db);
  if (o.refreshConnection) {
    const { useConnections } = await import('@/stores/connections');
    await useConnections.getState().refresh(o.connId).catch(() => {});
  }
  return true;
}

/** Fetch (cached) table DDL. */
export function fetchTableDdl(connId: string, db: string, schema: string, table: string) {
  return queryClient.fetchQuery({ queryKey: schemaKeys.ddl(connId, db, schema, table), queryFn: () => schemaApi.tableDdl(connId, db, schema, table), staleTime: 0 });
}
