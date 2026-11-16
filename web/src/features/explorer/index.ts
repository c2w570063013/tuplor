import { FolderPlus, PlusSquare, Database } from 'lucide-react';
import { createElement } from 'react';
import { registerCommands } from '@/shell/commands';
import { useWorkspace } from '@/stores/workspace';
import { createDatabase, createSchema, openCreateTable } from './actions';

export { ExplorerTree, openObject, objectIcon } from './ExplorerTree';

const active = () => {
  const { activeConnId, activeDb } = useWorkspace.getState();
  return activeConnId && activeDb ? { connId: activeConnId, db: activeDb } : null;
};

registerCommands([
  {
    id: 'structure.createTable', title: 'Create table…', group: 'Database', icon: createElement(PlusSquare, { size: 14 }),
    keywords: ['new table', 'designer', 'ddl'], when: () => !!active(),
    run: () => { const a = active(); if (a) openCreateTable(a.connId, a.db, 'public'); },
  },
  {
    id: 'structure.createSchema', title: 'Create schema…', group: 'Database', icon: createElement(FolderPlus, { size: 14 }),
    keywords: ['new schema', 'namespace'], when: () => !!active(),
    run: () => { const a = active(); if (a) createSchema(a.connId, a.db); },
  },
  {
    id: 'structure.createDatabase', title: 'Create database…', group: 'Database', icon: createElement(Database, { size: 14 }),
    keywords: ['new database'], when: () => !!active(),
    run: () => { const a = active(); if (a) createDatabase(a.connId); },
  },
]);
