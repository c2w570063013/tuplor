import { create } from 'zustand';
import type { ReactNode } from 'react';

/**
 * Command registry for the command palette (⌘K). Feature teams can register commands
 * from their own modules without touching the palette:
 *   registerCommands([{ id: 'erd.open', title: 'Open ER diagram', group: 'Tools', run: () => … }])
 */
export interface Command {
  id: string;
  title: string;
  group?: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string[];
  /** Hide when returns false (e.g. needs an active database). */
  when?: () => boolean;
  run: () => void;
}

export const useCommands = create<{ commands: Record<string, Command> }>(() => ({ commands: {} }));

export function registerCommands(cmds: Command[]) {
  useCommands.setState((s) => {
    const next = { ...s.commands };
    for (const c of cmds) next[c.id] = c;
    return { commands: next };
  });
}
