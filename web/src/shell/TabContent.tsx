import { Suspense } from 'react';
import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import { useWorkspace } from '@/stores/workspace';
import { TAB_REGISTRY } from '@/features/registry';
import { WelcomeScreen } from '@/features/welcome';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="text-danger" size={26} />
          <div className="text-sm font-medium">Something went wrong in this tab</div>
          <pre className="max-w-xl overflow-auto rounded-md bg-sunken p-3 text-left text-xs text-muted">{this.state.error.message}</pre>
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Renders every open tab; inactive tabs stay mounted (state preserved) but hidden. */
export function TabContent() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);
  if (!tabs.length) return <WelcomeScreen />;
  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((t) => {
        const entry = TAB_REGISTRY[t.kind];
        if (!entry) return null;
        const C = entry.component;
        const active = t.id === activeId;
        return (
          <div key={t.id} className="absolute inset-0" style={{ display: active ? 'block' : 'none' }}>
            <ErrorBoundary>
              <Suspense fallback={<div className="flex h-full items-center justify-center text-subtle"><Spinner size={18} /></div>}>
                <C tab={t} active={active} />
              </Suspense>
            </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
