import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  editorFontSize: number;
  gridFontSize: number;
  /** Rows fetched per page in table data view / max rows for editor results. */
  pageSize: number;
  editorMaxRows: number;
  confirmDangerous: boolean;
  showSystemSchemas: boolean;
  wordWrap: boolean;
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      theme: 'dark',
      editorFontSize: 13,
      gridFontSize: 12,
      pageSize: 200,
      editorMaxRows: 2000,
      confirmDangerous: true,
      showSystemSchemas: false,
      wordWrap: false,
      set: (patch) => set(patch),
    }),
    { name: 'tuplor.settings' },
  ),
);

export function resolvedTheme(theme: Settings['theme']): 'dark' | 'light' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

export function applyTheme(theme: Settings['theme']) {
  const t = resolvedTheme(theme);
  document.documentElement.classList.toggle('dark', t === 'dark');
  try { localStorage.setItem('tuplor.theme', t); } catch { /* ignore */ }
}

export const useResolvedTheme = () => resolvedTheme(useSettings((s) => s.theme));
