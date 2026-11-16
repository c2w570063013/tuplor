import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { DataGrid, type GridSort } from '@/components/grid';
import { Button, IconButton, Spinner, Toolbar } from '@/components/ui';
import { api, runSql } from '@/lib/api';
import { formatDuration, qualified, quoteIdent } from '@/lib/format';
import { useSettings } from '@/stores/settings';
import type { TabProps } from '../common/TabProps';

/** Basic table data browser (owned by the Data Grid team, who will extend it). */
export default function TableDataTab({ tab }: TabProps) {
  const { schema, table } = tab.params as { schema: string; table: string };
  const connId = tab.connId!;
  const db = tab.database!;
  const pageSize = useSettings((s) => s.pageSize);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<GridSort | null>(null);

  const cols = useQuery({ queryKey: ['columns', connId, db, schema, table], queryFn: () => api.columns(connId, db, schema, table) });
  const data = useQuery({
    queryKey: ['table-data', connId, db, schema, table, page, sort, pageSize],
    enabled: !!cols.data,
    queryFn: async () => {
      const order = sort && cols.data ? ` ORDER BY ${quoteIdent(cols.data[sort.col].name)} ${sort.dir.toUpperCase()}` : '';
      const t0 = performance.now();
      const r = await runSql(connId, db, `SELECT * FROM ${qualified(schema, table)}${order} LIMIT ${pageSize} OFFSET ${page * pageSize}`);
      return { ...r, ms: performance.now() - t0 };
    },
  });

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <IconButton label="Refresh" onClick={() => data.refetch()}><RefreshCw size={14} /></IconButton>
        <div className="flex-1" />
        {data.isFetching && <Spinner />}
        <Button variant="ghost" size="xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /></Button>
        <span className="text-xs text-muted">Page {page + 1}</span>
        <Button variant="ghost" size="xs" disabled={(data.data?.rows.length ?? 0) < pageSize} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></Button>
      </Toolbar>
      {data.error ? (
        <div className="p-4 text-xs text-danger">{(data.error as Error).message}</div>
      ) : (
        <DataGrid
          className="min-h-0 flex-1"
          columns={(cols.data ?? []).map((c) => ({ name: c.name, typeName: c.udtName, isPk: c.isPrimaryKey, description: `${c.name} · ${c.dataType}` }))}
          rows={data.data?.rows ?? []}
          rowOffset={page * pageSize}
          sort={sort}
          onSortChange={setSort}
        />
      )}
      <div className="flex h-6 shrink-0 items-center border-t border-border px-3 text-[11px] text-subtle">
        {schema}.{table} · {data.data?.rows.length ?? 0} rows · {formatDuration(data.data?.ms)}
      </div>
    </div>
  );
}
