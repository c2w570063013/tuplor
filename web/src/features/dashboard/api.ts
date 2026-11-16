import type {
  ActivitySession, CreateDatabaseRequest, DatabaseFormMeta, DatabaseRow, DropDatabaseRequest, IndexStat, LocksResponse,
  MaintenanceRequest, MonitorSnapshot, SettingRow, StatementsResponse, StatementsSort, TableStat,
} from '@shared/monitor';
import { dbUrl, http } from '@/lib/api';

const enc = encodeURIComponent;
const srv = (connId: string) => `/api/c/${enc(connId)}/monitor`;
const dbm = (connId: string, db: string) => `${dbUrl(connId, db)}/monitor`;

export const monitorApi = {
  snapshot: (connId: string, db?: string, signal?: AbortSignal) =>
    http.get<MonitorSnapshot>(`${srv(connId)}/snapshot${db ? `?db=${enc(db)}` : ''}`, signal),
  activity: (connId: string) => http.get<ActivitySession[]>(`${srv(connId)}/activity`),
  signal: (connId: string, pid: number, action: 'cancel' | 'terminate') =>
    http.post<{ ok: boolean }>(`${srv(connId)}/backends/${pid}/signal`, { action }),
  locks: (connId: string, db?: string) => http.get<LocksResponse>(`${srv(connId)}/locks${db ? `?db=${enc(db)}` : ''}`),
  settings: (connId: string) => http.get<SettingRow[]>(`${srv(connId)}/settings`),
  databases: (connId: string) => http.get<DatabaseRow[]>(`${srv(connId)}/databases`),
  databaseMeta: (connId: string) => http.get<DatabaseFormMeta>(`${srv(connId)}/databases/meta`),
  createDatabase: (connId: string, req: CreateDatabaseRequest) => http.post<{ sql: string }>(`${srv(connId)}/databases`, req),
  dropDatabase: (connId: string, req: DropDatabaseRequest) => http.post<{ sql: string }>(`${srv(connId)}/databases/drop`, req),
  tables: (connId: string, db: string) => http.get<TableStat[]>(`${dbm(connId, db)}/tables`),
  indexes: (connId: string, db: string) => http.get<IndexStat[]>(`${dbm(connId, db)}/indexes`),
  maintenance: (connId: string, db: string, req: MaintenanceRequest) =>
    http.post<{ sql: string; durationMs?: number }>(`${dbm(connId, db)}/maintenance`, req),
  statements: (connId: string, db: string, sort: StatementsSort, scope: 'db' | 'all') =>
    http.get<StatementsResponse>(`${dbm(connId, db)}/statements?sort=${sort}&scope=${scope}&limit=200`),
  resetStatements: (connId: string, db: string) => http.post<{ ok: boolean }>(`${dbm(connId, db)}/statements/reset`),
  installStatements: (connId: string, db: string) => http.post<{ ok: boolean }>(`${dbm(connId, db)}/statements/install`),
};

/** Query keys (all prefixed with 'monitor' so a dashboard refresh can invalidate everything). */
export const mk = {
  all: (connId: string) => ['monitor', connId] as const,
  activity: (connId: string) => ['monitor', connId, 'activity'] as const,
  locks: (connId: string, db: string) => ['monitor', connId, 'locks', db] as const,
  settings: (connId: string) => ['monitor', connId, 'settings'] as const,
  databases: (connId: string) => ['monitor', connId, 'databases'] as const,
  databaseMeta: (connId: string) => ['monitor', connId, 'databases-meta'] as const,
  tables: (connId: string, db: string) => ['monitor', connId, 'tables', db] as const,
  indexes: (connId: string, db: string) => ['monitor', connId, 'indexes', db] as const,
  statements: (connId: string, db: string, sort: string, scope: string) => ['monitor', connId, 'statements', db, sort, scope] as const,
};
