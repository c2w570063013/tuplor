import type {
  CommitRequest, CommitResponse, CountResponse, ExportFormat, ImportBatchRequest, ImportBatchResponse, ImportBeginRequest,
  ImportBeginResponse, RowsQuery, RowsRequest, RowsResponse, TableColumn, TableInfo,
} from '@shared/tableData';
import { dbUrl, http } from '@/lib/api';

const enc = encodeURIComponent;
const base = (connId: string, db: string, schema: string, table: string) =>
  `${dbUrl(connId, db)}/table-data/${enc(schema)}/${enc(table)}`;

export const tableApi = {
  info: (c: string, d: string, s: string, t: string) => http.get<TableInfo>(`${base(c, d, s, t)}/info`),
  rows: (c: string, d: string, s: string, t: string, req: RowsRequest, signal?: AbortSignal) =>
    http.post<RowsResponse>(`${base(c, d, s, t)}/rows`, req, signal),
  count: (c: string, d: string, s: string, t: string, q: RowsQuery, exact: boolean) =>
    http.post<CountResponse>(`${base(c, d, s, t)}/count`, { ...q, exact }),
  commit: (c: string, d: string, s: string, t: string, req: CommitRequest) => http.post<CommitResponse>(`${base(c, d, s, t)}/commit`, req),
  exportUrl: (c: string, d: string, s: string, t: string, format: ExportFormat, q: RowsQuery, columns?: string[]) => {
    const p = new URLSearchParams({ format });
    if (q.filters?.length || q.where || q.sort?.length) p.set('q', JSON.stringify(q));
    if (columns?.length) p.set('columns', columns.join(','));
    return `${base(c, d, s, t)}/export?${p}`;
  },
  importBegin: (c: string, d: string, s: string, t: string, req: ImportBeginRequest) =>
    http.post<ImportBeginResponse>(`${base(c, d, s, t)}/import/begin`, req),
  importBatch: (c: string, d: string, s: string, t: string, id: string, req: ImportBatchRequest) =>
    http.post<ImportBatchResponse>(`${base(c, d, s, t)}/import/${enc(id)}/batch`, req),
  importCommit: (c: string, d: string, s: string, t: string, id: string) =>
    http.post<{ ok: boolean; total: number }>(`${base(c, d, s, t)}/import/${enc(id)}/commit`),
  importRollback: (c: string, d: string, s: string, t: string, id: string) =>
    http.post<{ ok: boolean }>(`${base(c, d, s, t)}/import/${enc(id)}/rollback`),
};

const SHORT: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  'timestamp with time zone': 'timestamptz',
  'timestamp without time zone': 'timestamp',
  'time with time zone': 'timetz',
  'time without time zone': 'time',
  'double precision': 'float8',
  integer: 'int4',
  smallint: 'int2',
  bigint: 'int8',
  boolean: 'bool',
  real: 'float4',
};

/** Compact type label for grid headers: varchar(32), int4[], numeric(12,2), order_status … */
export function shortType(c: TableColumn): string {
  let t = c.dataType;
  const arr = t.endsWith('[]');
  if (arr) t = t.slice(0, -2);
  const m = /^([a-z ]+?)(\(.*\))?$/.exec(t);
  if (m && SHORT[m[1]]) t = SHORT[m[1]] + (m[2] ?? '');
  const dot = t.lastIndexOf('.');
  if (dot > 0 && !t.includes('(')) t = t.slice(dot + 1).replace(/"/g, '');
  return t + (arr ? '[]' : '');
}

export const TEMPORAL_HINT: Record<string, string> = {
  date: 'YYYY-MM-DD',
  timestamp: 'YYYY-MM-DD HH:MM:SS',
  timestamptz: 'YYYY-MM-DD HH:MM:SS+TZ',
  time: 'HH:MM:SS',
  timetz: 'HH:MM:SS+TZ',
  interval: 'e.g. 1 day 02:00:00',
  uuid: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
};
