import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
  },
});

/**
 * Query key conventions (so features can invalidate each other's caches):
 *   ['schemas', connId, db]
 *   ['objects', connId, db, schema]
 *   ['columns', connId, db, schema, table]
 * After DDL, call invalidateDb(connId, db) to refresh the explorer.
 */
export function invalidateDb(connId: string, db: string) {
  queryClient.invalidateQueries({ queryKey: ['schemas', connId, db] });
  queryClient.invalidateQueries({ queryKey: ['objects', connId, db] });
  queryClient.invalidateQueries({ queryKey: ['columns', connId, db] });
}
