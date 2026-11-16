import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui';
import { useConnections } from '@/stores/connections';
import { DialogHost } from '@/stores/dialogs';
import { applyTheme, useResolvedTheme, useSettings } from '@/stores/settings';
import { useWorkspace } from '@/stores/workspace';
import { ConnectionDialog } from '@/features/connections/ConnectionDialog';
import { ExplorerTree } from '@/features/explorer';
import { CommandPalette } from '@/shell/CommandPalette';
import { StatusBar } from '@/shell/StatusBar';
import { TabBar } from '@/shell/TabBar';
import { TabContent } from '@/shell/TabContent';
import { TopBar } from '@/shell/TopBar';
import { useGlobalShortcuts } from '@/shell/useGlobalShortcuts';

export default function App() {
  const theme = useSettings((s) => s.theme);
  const resolved = useResolvedTheme();
  const collapsed = useWorkspace((s) => s.sidebarCollapsed);
  useGlobalShortcuts();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    const { load, connect } = useConnections.getState();
    load().then(() => {
      // Reconnect to connections referenced by restored tabs / active db.
      const ws = useWorkspace.getState();
      const ids = new Set([ws.activeConnId, ...ws.tabs.map((t) => t.connId)].filter(Boolean) as string[]);
      const known = new Set(useConnections.getState().list.map((c) => c.id));
      ids.forEach((id) => known.has(id) && connect(id).catch(() => {}));
    });
  }, []);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full flex-col">
        <TopBar />
        <Group orientation="horizontal" className="min-h-0 flex-1">
          {!collapsed && (
            <>
              <Panel id="sidebar" defaultSize="280px" minSize="200px" maxSize="50%" className="bg-panel">
                <ExplorerTree />
              </Panel>
              <Separator />
            </>
          )}
          <Panel id="main" minSize="30%">
            <div className="flex h-full flex-col bg-bg">
              <TabBar />
              <TabContent />
            </div>
          </Panel>
        </Group>
        <StatusBar />
      </div>
      <ConnectionDialog />
      <CommandPalette />
      <DialogHost />
      <Toaster theme={resolved} position="bottom-right" richColors closeButton toastOptions={{ className: 'text-[13px]' }} />
    </TooltipProvider>
  );
}
