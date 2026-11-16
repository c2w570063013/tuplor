// PG Studio — Electron main process.
//
// Boot sequence: pick a port → fork the bundled server (out/server/index.mjs, or
// Resources/server/index.mjs when packaged) in an Electron utility process → wait for
// /api/health → load http://127.0.0.1:<port>/ in the main window.
//
// Env overrides (dev only):
//   PGSTUDIO_URL=http://localhost:5173   don't start a server, load this URL (e.g. Vite dev server)
//   PGSTUDIO_DEVTOOLS=1                  open devtools on start
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'PG Studio';
const IS_MAC = process.platform === 'darwin';
// Stable preferred port: the UI keeps tabs/settings in localStorage, which is per-origin,
// so a random port on every launch would wipe the workspace. Fall back to a free port.
const PREFERRED_PORT = 45555;

app.setName(APP_NAME);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Paths & small persistence helpers

const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'out');
const serverEntry = path.join(resourcesRoot, 'server', 'index.mjs');
const userData = app.getPath('userData');
const logDir = path.join(userData, 'logs');
const stateFile = path.join(userData, 'window-state.json');
const prefsFile = path.join(userData, 'desktop.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------------------------
// Server child process

let server = null; // UtilityProcess
let serverUrl = process.env.PGSTUDIO_URL || null;
let quitting = false;
let serverLog = null;
const logTail = [];

function log(line) {
  logTail.push(line);
  if (logTail.length > 200) logTail.shift();
  serverLog?.write(line.endsWith('\n') ? line : line + '\n');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
}

function randomFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function pickPort() {
  const prefs = readJson(prefsFile, {});
  for (const p of [prefs.port, PREFERRED_PORT].filter(Boolean)) {
    if (await isPortFree(p)) return p;
  }
  const port = await randomFreePort();
  writeJson(prefsFile, { ...prefs, port });
  return port;
}

/** Finder-launched apps get a minimal PATH; add the usual PostgreSQL client locations (pg_dump…). */
function augmentedPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin'];
  for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
    try {
      for (const d of fs.readdirSync(base)) if (/^(postgresql|libpq)/.test(d)) extra.push(path.join(base, d, 'bin'));
    } catch {
      /* not installed */
    }
  }
  const parts = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  for (const p of extra) if (!parts.includes(p) && fs.existsSync(p)) parts.push(p);
  return parts.join(':');
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!server) throw new Error('The server process exited during startup.');
    try {
      const res = await fetch(url + 'api/health', { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The server did not become ready within ${timeoutMs / 1000}s.`);
}

async function startServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Server bundle not found at ${serverEntry}.\nRun \`npm run desktop:dev\` (it builds it) from the repo root.`);
  }
  fs.mkdirSync(logDir, { recursive: true });
  serverLog ??= fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'w' });

  const port = await pickPort();
  const url = `http://127.0.0.1:${port}/`;
  log(`[desktop] starting ${serverEntry} on ${url}`);

  const child = utilityProcess.fork(serverEntry, [], {
    serviceName: `${APP_NAME} Server`,
    stdio: 'pipe',
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PATH: augmentedPath(),
      PGSTUDIO_DESKTOP: '1',
      PGSTUDIO_WEB_DIST: path.join(resourcesRoot, 'web', 'dist'),
      NODE_ENV: 'production',
    },
  });
  server = child;
  child.stdout?.on('data', (d) => log(String(d)));
  child.stderr?.on('data', (d) => log(String(d)));
  child.on('exit', (code) => {
    log(`[desktop] server exited with code ${code}`);
    if (server === child) server = null;
    if (!quitting && serverUrl) onServerCrash(code);
  });

  await waitForHealth(url, 30_000);
  serverUrl = url;
  return url;
}

let restarting = false;
async function onServerCrash(code) {
  if (restarting) return;
  restarting = true;
  const choice = await dialog.showMessageBox({
    type: 'error',
    message: `${APP_NAME} server stopped unexpectedly (code ${code}).`,
    detail: logTail.slice(-12).join('').slice(-1500),
    buttons: ['Restart Server', 'Quit'],
    defaultId: 0,
  });
  if (choice.response === 1) return app.quit();
  try {
    serverUrl = null;
    const url = await startServer();
    for (const w of BrowserWindow.getAllWindows()) w.loadURL(url);
  } catch (e) {
    fatal(e);
  } finally {
    restarting = false;
  }
}

function stopServer() {
  if (server) {
    try {
      server.kill();
    } catch {
      /* already gone */
    }
    server = null;
  }
}

function fatal(err) {
  dialog.showErrorBox(
    `${APP_NAME} could not start`,
    `${err?.message || err}\n\n${logTail.slice(-15).join('').slice(-2000)}\n\nLog: ${path.join(logDir, 'server.log')}`,
  );
  quitting = true;
  stopServer();
  app.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Window

let mainWindow = null;

function loadWindowState() {
  const s = readJson(stateFile, null);
  const fallback = { width: 1440, height: 900 };
  if (!s?.bounds) return fallback;
  // Only restore a position that is still (mostly) visible on a connected display.
  const area = screen.getDisplayMatching(s.bounds).workArea;
  const visible =
    s.bounds.x < area.x + area.width - 100 &&
    s.bounds.x + s.bounds.width > area.x + 100 &&
    s.bounds.y >= area.y - 10 &&
    s.bounds.y < area.y + area.height - 100;
  const width = Math.min(s.bounds.width, area.width);
  const height = Math.min(s.bounds.height, area.height);
  return visible ? { ...s.bounds, width, height, maximized: s.maximized } : { width, height, maximized: s.maximized };
}

function trackWindowState(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    writeJson(stateFile, { bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), maximized: win.isMaximized() });
  };
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('close', save);
}

// Make the top bar a drag region and leave room for the traffic lights (hiddenInset title bar).
// Targets `[data-titlebar]` (preferred) or, as a fallback, the first child of the app shell.
const TITLEBAR_CSS = `
html.pgs-darwin :is([data-titlebar], #root > div.h-full.flex-col > div:first-child) {
  -webkit-app-region: drag;
  -webkit-user-select: none;
}
html.pgs-darwin:not(.pgs-fullscreen) :is([data-titlebar], #root > div.h-full.flex-col > div:first-child) {
  padding-left: 78px !important;
}
html.pgs-darwin :is([data-titlebar], #root > div.h-full.flex-col > div:first-child)
  :is(button, a, input, select, textarea, [role="button"], [role="combobox"], [role="menuitem"], [data-no-drag]) {
  -webkit-app-region: no-drag;
}
`;

function isAppUrl(url) {
  return !!serverUrl && url.startsWith(serverUrl.replace(/\/$/, ''));
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121316' : '#ffffff',
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();
  trackWindowState(win);

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    if (IS_MAC) win.webContents.insertCSS(TITLEBAR_CSS);
    sendWindowState(win);
  });
  win.on('enter-full-screen', () => sendWindowState(win));
  win.on('leave-full-screen', () => sendWindowState(win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // External links → default browser. Blob/data URLs (exports, previews) stay in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (/^(blob|data):/i.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });

  if (process.env.PGSTUDIO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  win.loadURL(serverUrl);
  return win;
}

function sendWindowState(win) {
  if (!win.isDestroyed()) win.webContents.send('pgstudio:window-state', { fullscreen: win.isFullScreen() });
}

// ---------------------------------------------------------------------------------------------
// Menu & renderer commands

/** Renderer windows that registered a command handler (via preload `onCommand`). */
const bridged = new Set();
ipcMain.on('pgstudio:bridge-ready', (e) => bridged.add(e.sender.id));

function focusedWebContents() {
  return (BrowserWindow.getFocusedWindow() || mainWindow)?.webContents;
}

/** Send a command to the renderer. Returns false when the page has no bridge wired up yet. */
function sendCommand(command) {
  const wc = focusedWebContents();
  if (!wc || !bridged.has(wc.id)) return false;
  wc.send('pgstudio:command', command);
  return true;
}

function buildMenu() {
  const cmd = (label, command, accelerator, extra = {}) => ({
    label,
    accelerator,
    click: () => sendCommand(command),
    ...extra,
  });

  const template = [
    ...(IS_MAC
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              cmd('Settings…', 'open-settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        cmd('New Query', 'new-query', 'CmdOrCtrl+T'),
        cmd('New Connection…', 'new-connection', 'CmdOrCtrl+N'),
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          // Without a wired bridge (or with no window), ⌘W behaves like a normal Close Window.
          click: (_item, win) => {
            if (!sendCommand('close-tab')) (win || BrowserWindow.getFocusedWindow())?.close();
          },
        },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(IS_MAC ? [] : [{ type: 'separator' }, cmd('Settings…', 'open-settings', 'CmdOrCtrl+,'), { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // The web app already handles ⌘B / ⌘K itself, so these only show the shortcut
        // (registerAccelerator: false) and send the command when clicked.
        cmd('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B', { registerAccelerator: false }),
        cmd('Command Palette…', 'command-palette', 'CmdOrCtrl+K', { registerAccelerator: false }),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Open in Browser',
          click: () => serverUrl && shell.openExternal(serverUrl),
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'PostgreSQL Documentation', click: () => shell.openExternal('https://www.postgresql.org/docs/current/') },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => shell.openPath(process.env.PGSTUDIO_HOME || path.join(app.getPath('home'), '.pgstudio')) },
        { label: 'Show Server Log', click: () => shell.openPath(path.join(logDir, 'server.log')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

app.on('second-instance', () => {
  if (!mainWindow) return serverUrl && createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  stopServer();
});
app.on('will-quit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());

app.whenReady().then(async () => {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Free & open PostgreSQL management',
    iconPath: app.isPackaged ? undefined : path.join(__dirname, '..', 'build', 'icon.png'),
  });
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  buildMenu();
  try {
    if (!serverUrl) await startServer();
    else if (!serverUrl.endsWith('/')) serverUrl += '/';
    createWindow();
  } catch (e) {
    fatal(e);
  }
});
