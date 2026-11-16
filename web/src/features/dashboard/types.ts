/** Props shared by every dashboard section. */
export interface SectionProps {
  connId: string;
  /** Database the dashboard tab is opened on (used by database-scoped sections). */
  database: string;
  /** Auto-refresh is on: tab visible and not paused. */
  live: boolean;
  intervalMs: number;
  /** Persisted per-tab view state (tab.params). */
  params: Record<string, any>;
  setParams: (patch: Record<string, any>) => void;
}
