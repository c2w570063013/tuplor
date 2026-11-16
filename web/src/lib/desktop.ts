/**
 * Bridge to the PG Studio desktop shell (Electron). No-op in a normal browser.
 *
 * The preload script exposes `window.pgstudioDesktop`; the native menu sends commands
 * (⌘T new query, ⌘N new connection, ⌘W close tab, ⌘, settings, ⌘B sidebar, ⌘K palette).
 *
 * Usage (once, at app start):
 *   useEffect(() => initDesktopBridge({ 'new-query': () => …, … }), []);
 */

export type DesktopCommand = 'new-query' | 'new-connection' | 'close-tab' | 'open-settings' | 'toggle-sidebar' | 'command-palette';

export type DesktopHandlers = Partial<Record<DesktopCommand, () => void>>;

export interface PgStudioDesktop {
  isDesktop: true;
  platform: string;
  onCommand(cb: (command: string) => void): () => void;
}

declare global {
  interface Window {
    pgstudioDesktop?: PgStudioDesktop;
  }
}

export const desktop: PgStudioDesktop | undefined = typeof window !== 'undefined' ? window.pgstudioDesktop : undefined;

/** True when running inside the desktop app. */
export const isDesktop = !!desktop?.isDesktop;

/** True inside the macOS desktop app (hidden-inset title bar: traffic lights sit over the top bar's left ~78px). */
export const isMacDesktop = isDesktop && desktop?.platform === 'darwin';

/**
 * Route native-menu commands to handlers. Returns an unsubscribe function (usable as a
 * useEffect cleanup). Until this is called, ⌘W closes the window and ⌘T/⌘N do nothing.
 */
export function initDesktopBridge(handlers: DesktopHandlers): () => void {
  if (!desktop) return () => {};
  return desktop.onCommand((command) => handlers[command as DesktopCommand]?.());
}
