import type { Tab } from '@/stores/workspace';

/** Props every tab component receives. `active` = currently visible (tabs stay mounted when hidden). */
export interface TabProps {
  tab: Tab;
  active: boolean;
}
