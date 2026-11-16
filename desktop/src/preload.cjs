// PG Studio — preload (sandboxed). Exposes a tiny, typed-by-convention bridge to the web app:
//
//   window.pgstudioDesktop = {
//     isDesktop: true,
//     platform: 'darwin' | 'win32' | 'linux',
//     onCommand(cb: (command: string) => void): () => void   // returns an unsubscribe fn
//   }
//
// Commands sent from the native menu: 'new-query', 'new-connection', 'close-tab',
// 'open-settings', 'toggle-sidebar', 'command-palette'.
// It also tags <html> with `pgs-desktop pgs-<platform>` (+ `pgs-fullscreen`) for CSS.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('pgstudio:command', (_e, command) => {
  for (const cb of listeners) {
    try {
      cb(command);
    } catch (err) {
      console.error('[pgstudio] command handler failed', err);
    }
  }
});

contextBridge.exposeInMainWorld('pgstudioDesktop', {
  isDesktop: true,
  platform: process.platform,
  onCommand(cb) {
    if (typeof cb !== 'function') throw new TypeError('onCommand expects a function');
    listeners.add(cb);
    ipcRenderer.send('pgstudio:bridge-ready');
    return () => listeners.delete(cb);
  },
});

function tagRoot(extra) {
  const html = document.documentElement;
  html.classList.add('pgs-desktop', `pgs-${process.platform}`);
  if (extra) html.classList.toggle('pgs-fullscreen', !!extra.fullscreen);
}
ipcRenderer.on('pgstudio:window-state', (_e, state) => tagRoot(state));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => tagRoot());
else tagRoot();
