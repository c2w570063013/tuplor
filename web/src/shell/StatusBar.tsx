import { useConnections } from '@/stores/connections';
import { useWorkspace } from '@/stores/workspace';

export function StatusBar() {
  const activeConnId = useWorkspace((s) => s.activeConnId);
  const activeDb = useWorkspace((s) => s.activeDb);
  const tabs = useWorkspace((s) => s.tabs.length);
  const conn = useConnections((s) => s.list.find((c) => c.id === activeConnId));
  const st = useConnections((s) => (activeConnId ? s.state[activeConnId] : undefined));
  const version = st?.info?.version.match(/PostgreSQL [\d.]+/)?.[0];
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-subtle">
      {conn ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${st?.status === 'connected' ? 'bg-success' : 'bg-subtle'}`} />
            {conn.user}@{conn.host}:{conn.port}
          </span>
          {activeDb && <span>db: <span className="text-muted">{activeDb}</span></span>}
          {version && <span>{version}</span>}
          {st?.info?.isSuperuser && <span className="text-warning">superuser</span>}
          {conn.readOnly && <span className="text-info">read-only</span>}
        </>
      ) : (
        <span>Not connected</span>
      )}
      <div className="flex-1" />
      <span>{tabs} tab{tabs === 1 ? '' : 's'}</span>
    </div>
  );
}
