/**
 * Bridge to the PG Studio desktop shell (Electron). No-op in a normal browser.
 *
 * The preload script exposes `window.pgstudioDesktop`; the native menu sends commands
 * (⌘T new query, ⌘N new connection, ⌘W close tab, ⌘, settings, ⌘B sidebar, ⌘K palette).
 *
 * Usage (once, at app start):
 *   useEffect(() => initDesktopBridge({ 'new-query': () => …, … }), []);
 *
 * initDesktopBridge also starts the update notice (a toast when a newer GitHub release exists).
 */
import { toast } from 'sonner';

export type DesktopCommand = 'new-query' | 'new-connection' | 'close-tab' | 'open-settings' | 'toggle-sidebar' | 'command-palette';

export type DesktopHandlers = Partial<Record<DesktopCommand, () => void>>;

/** A newer GitHub release than the running app (see desktop/src/main.cjs `checkForUpdate`). */
export interface DesktopUpdateInfo {
  version: string;
  current: string;
  /** Release page on github.com. */
  url: string;
  name?: string;
}

export interface PgStudioDesktop {
  isDesktop: true;
  platform: string;
  onCommand(cb: (command: string) => void): () => void;
  /** Absent in desktop builds older than the update notice. */
  checkForUpdate?(): Promise<DesktopUpdateInfo | null>;
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
  const offCommands = desktop.onCommand((command) => handlers[command as DesktopCommand]?.());
  const offUpdate = initUpdateNotice();
  return () => {
    offCommands();
    offUpdate();
  };
}

/**
 * Shortly after start, ask the desktop shell whether a newer release exists (the shell checks
 * GitHub at most once a day and stays silent offline) and show a non-blocking toast with a
 * "Download" button that opens the release page in the default browser. No auto-install.
 */
function initUpdateNotice(): () => void {
  const bridge = desktop;
  if (!bridge?.checkForUpdate) return () => {};
  let cancelled = false;
  const timer = setTimeout(() => {
    bridge
      .checkForUpdate?.()
      .then((u) => {
        if (cancelled || !u) return;
        toast.info(`Update available: v${u.version}`, {
          id: 'desktop-update',
          description: `You're on v${u.current}. Download the new version from GitHub.`,
          duration: Infinity,
          action: { label: 'Download', onClick: () => window.open(u.url, '_blank') },
        });
      })
      .catch(() => {});
  }, 3000);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
