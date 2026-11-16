import { useEffect } from 'react';
import { useWorkspace } from '@/stores/workspace';
import { useCommandPalette } from './CommandPalette';

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useCommandPalette.getState().setOpen(!useCommandPalette.getState().open);
      } else if (mod && e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault();
        useWorkspace.getState().toggleSidebar();
      } else if (e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        useWorkspace.getState().newQuery();
      } else if (e.altKey && e.code === 'KeyW') {
        e.preventDefault();
        const s = useWorkspace.getState();
        if (s.activeTabId) s.closeTab(s.activeTabId);
      } else if (mod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const s = useWorkspace.getState();
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        const n = s.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + s.tabs.length) % s.tabs.length];
        if (n) s.setActiveTab(n.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
