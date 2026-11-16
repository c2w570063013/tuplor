import { Upload } from 'lucide-react';
import { registerCommands } from '@/shell/commands';
import { useWorkspace } from '@/stores/workspace';

/**
 * Palette commands of the Data Grid & Table Data feature. Registered when this module is
 * first imported (the table-data tab imports it; the shell may import it eagerly too).
 */
registerCommands([
  {
    id: 'table-data.import-csv',
    title: 'Import CSV…',
    group: 'Tools',
    icon: <Upload size={14} />,
    keywords: ['csv', 'tsv', 'import', 'load', 'upload'],
    when: () => !!useWorkspace.getState().activeConnId && !!useWorkspace.getState().activeDb,
    run: () => {
      const ws = useWorkspace.getState();
      const active = ws.tabs.find((t) => t.id === ws.activeTabId);
      const fromTable = active?.kind === 'table-data' ? active.params : null;
      const connId = active?.connId ?? ws.activeConnId!;
      const database = active?.database ?? ws.activeDb!;
      ws.openTab({
        kind: 'import',
        title: fromTable ? `Import · ${fromTable.table}` : 'Import CSV',
        connId,
        database,
        key: fromTable ? `import:${connId}:${database}:${fromTable.schema}.${fromTable.table}` : undefined,
        params: fromTable ? { schema: fromTable.schema, table: fromTable.table } : {},
      });
    },
  },
]);
