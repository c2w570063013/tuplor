import { Database, FileCode2, Plus, Plug, Activity, Network, Keyboard } from 'lucide-react';
import { Button, Kbd, toast } from '@/components/ui';
import { modKey } from '@/lib/format';
import { useConnections } from '@/stores/connections';
import { useWorkspace } from '@/stores/workspace';
import { useConnectionDialog } from '../connections/ConnectionDialog';
import type { TabProps } from '../common/TabProps';

export function WelcomeScreen() {
  const list = useConnections((s) => s.list);
  const state = useConnections((s) => s.state);
  const show = useConnectionDialog((s) => s.show);
  const ws = useWorkspace();

  const open = async (id: string, db: string) => {
    try {
      await useConnections.getState().connect(id);
      ws.setActiveDb(id, db);
      ws.newQuery({ connId: id, database: db });
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-8 py-16">
        <div className="flex items-center gap-4">
          <img src="/logo.svg" className="h-14 w-14 rounded-2xl shadow-lg" alt="" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">Tuplor</h1>
            <p className="text-sm text-muted">A fast, beautiful and free PostgreSQL workbench.</p>
          </div>
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wider text-subtle uppercase">Connections</h2>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => show()}>New connection</Button>
          </div>
          {list.length === 0 ? (
            <button
              onClick={() => show()}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong py-10 text-muted transition-colors hover:border-accent hover:text-fg"
            >
              <Plug size={22} />
              <span className="text-sm font-medium">Add your first PostgreSQL connection</span>
              <span className="text-xs text-subtle">Paste a postgres:// URL or fill in host, port and credentials</span>
            </button>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => open(c.id, c.database)}
                  className="group flex items-center gap-3 rounded-xl border border-border bg-panel p-3 text-left transition-all hover:border-border-strong hover:bg-hover"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: (c.color || '#6b85ff') + '22', color: c.color || '#6b85ff' }}>
                    <Database size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate text-[13px] font-medium text-fg">
                      {c.name}
                      {state[c.id]?.status === 'connected' && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
                    </div>
                    <div className="truncate font-mono text-[11px] text-subtle">{c.user}@{c.host}:{c.port}/{c.database}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: <FileCode2 size={16} />, title: 'SQL editor', text: 'Autocomplete, multi-statement runs, explain plans, history.' },
            { icon: <Activity size={16} />, title: 'Live dashboard', text: 'Sessions, locks, cache hit ratio, slow queries.' },
            { icon: <Network size={16} />, title: 'ER diagrams', text: 'Visualize relations across your schema.' },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-border p-4">
              <div className="mb-2 text-accent">{f.icon}</div>
              <div className="text-[13px] font-medium text-fg">{f.title}</div>
              <div className="mt-1 text-xs text-muted">{f.text}</div>
            </div>
          ))}
        </section>

        <section className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
          <Keyboard size={14} className="text-subtle" />
          <span><Kbd>{modKey} K</Kbd> Command palette</span>
          <span><Kbd>{modKey} ↵</Kbd> Run query</span>
          <span><Kbd>Alt N</Kbd> New query</span>
          <span><Kbd>{modKey} B</Kbd> Toggle sidebar</span>
        </section>
      </div>
    </div>
  );
}

export default function WelcomeTab(_: TabProps) {
  return <WelcomeScreen />;
}
