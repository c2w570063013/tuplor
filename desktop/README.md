# PG Studio — Desktop (macOS)

The desktop app is a thin Electron shell around the regular PG Studio server + web UI.

```
Electron main (src/main.cjs)
 ├─ utilityProcess → Resources/server/index.mjs   (server/dist bundled with all deps, single file)
 │                    PORT=<45555 or free>, HOST=127.0.0.1, serves Resources/web/dist
 └─ BrowserWindow  → http://127.0.0.1:<port>/     (preload: src/preload.cjs)
```

## Commands (run from the repo root)

| Command | What it does |
|---|---|
| `npm run app` | Browser users: build if needed, start the server on :5555, open the default browser |
| `npm run desktop:dev` | Build web + server, stage them into `desktop/out/`, launch Electron |
| `npm run desktop:build` | Same, then package `desktop/release/mac-arm64/PG Studio.app` and `desktop/release/PG-Studio-<ver>-arm64.dmg` |
| `npm run desktop:smoke` | End-to-end check of the packaged app (UI, preload bridge, DB connection, clean quit) |

`desktop/` is a standalone npm package (not a workspace); its deps install on first use.
For UI hot-reload inside Electron: `npm run dev` in one terminal, then
`PGSTUDIO_URL=http://localhost:5173 npx --prefix desktop electron desktop`.

## Opening the unsigned app

The app is ad-hoc signed, not notarized. On first launch macOS will refuse a double-click:
**right-click (or Control-click) "PG Studio" → Open → Open**. Alternatively System Settings →
Privacy & Security → "Open Anyway". If a copied/downloaded app says it is *damaged*, remove the
quarantine flag: `xattr -dr com.apple.quarantine "/Applications/PG Studio.app"`.

## Details

* **Data**: connections live in `~/.pgstudio` (shared with the browser version). Window state,
  the chosen port and `logs/server.log` live in `~/Library/Application Support/PG Studio/`.
* **Port**: 45555 is preferred so the UI's localStorage (tabs, settings — keyed by origin)
  survives restarts; if busy, a free port is chosen and remembered.
* **PATH**: Homebrew / Postgres.app `bin` dirs are appended so `pg_dump`/`psql` are found when
  launched from Finder.
* **Menu → web**: the native menu sends `new-query` (⌘T), `new-connection` (⌘N), `close-tab` (⌘W),
  `open-settings` (⌘,), `toggle-sidebar` (⌘B), `command-palette` (⌘K) through
  `window.pgstudioDesktop.onCommand`. Use `initDesktopBridge()` from `web/src/lib/desktop.ts`.
  ⌘B/⌘K are display-only in the menu (the web handles those keys itself).
* **Title bar**: `hiddenInset`; the top bar becomes a drag region with 78px left padding for the
  traffic lights (CSS injected by the main process; targets `[data-titlebar]` or the shell's first row).
* **Icon**: `npm run icon --prefix desktop` regenerates `build/icon.icns` from `web/public/logo.svg`.
