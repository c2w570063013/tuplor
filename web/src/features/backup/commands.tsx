import { Archive, ArchiveRestore } from 'lucide-react';
import { registerCommands } from '@/shell/commands';
import { useWorkspace } from '@/stores/workspace';

/**
 * Extra palette commands for Backup & restore. Registered when the backup module loads;
 * import this file eagerly (e.g. from main.tsx) to have them available from app start.
 */
// Palette shortcuts straight into restore mode (the generic "Backup & restore" entry lives in the shell).
registerCommands([
  {
    id: 'backup.restore',
    title: 'Restore database from backup…',
    group: 'Tools',
    icon: <ArchiveRestore size={14} />,
    keywords: ['pg_restore', 'import dump', 'psql'],
    when: () => !!useWorkspace.getState().activeConnId && !!useWorkspace.getState().activeDb,
    run: () => {
      const { activeConnId: connId, activeDb: database } = useWorkspace.getState();
      if (!connId || !database) return;
      useWorkspace.getState().openTab({ kind: 'backup', title: `Backup · ${database}`, connId, database, key: `backup:${connId}:${database}`, params: { mode: 'restore' } });
    },
  },
  {
    id: 'backup.backupNow',
    title: 'Back up current database…',
    group: 'Tools',
    icon: <Archive size={14} />,
    keywords: ['pg_dump', 'dump', 'export database'],
    when: () => !!useWorkspace.getState().activeConnId && !!useWorkspace.getState().activeDb,
    run: () => {
      const { activeConnId: connId, activeDb: database } = useWorkspace.getState();
      if (!connId || !database) return;
      useWorkspace.getState().openTab({ kind: 'backup', title: `Backup · ${database}`, connId, database, key: `backup:${connId}:${database}`, params: { mode: 'backup' } });
    },
  },
]);
