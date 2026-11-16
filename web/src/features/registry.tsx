import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity, Database, FileCode2, Home, Network, Settings, ShieldCheck, Table2, TableProperties, Upload, Workflow, Archive, PlusSquare, Braces,
  type LucideIcon,
} from 'lucide-react';
import type { TabKind } from '@/stores/workspace';
import type { TabProps } from './common/TabProps';

/**
 * Tab kind -> component. Each feature team owns its own folder under features/
 * and exports its tab component from the file referenced here.
 * (Owned by the commander: ask before changing.)
 */
export const TAB_REGISTRY: Record<TabKind, { component: LazyExoticComponent<ComponentType<TabProps>>; icon: LucideIcon }> = {
  welcome: { component: lazy(() => import('./welcome')), icon: Home },
  sql: { component: lazy(() => import('./sql-editor')), icon: FileCode2 },
  'table-data': { component: lazy(() => import('./table-data')), icon: Table2 },
  structure: { component: lazy(() => import('./structure')), icon: TableProperties },
  'create-table': { component: lazy(() => import('./structure/CreateTableTab')), icon: PlusSquare },
  object: { component: lazy(() => import('./structure/ObjectTab')), icon: Braces },
  dashboard: { component: lazy(() => import('./dashboard')), icon: Activity },
  roles: { component: lazy(() => import('./roles')), icon: ShieldCheck },
  erd: { component: lazy(() => import('./erd')), icon: Network },
  backup: { component: lazy(() => import('./backup')), icon: Archive },
  import: { component: lazy(() => import('./table-data/ImportTab')), icon: Upload },
  explain: { component: lazy(() => import('./explain')), icon: Workflow },
  settings: { component: lazy(() => import('./settings')), icon: Settings },
};

export const DatabaseIcon = Database;
