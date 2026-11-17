# Tuplor — Architecture & Team Handbook

Tuplor is a free, local-first PostgreSQL management tool: a Node (Fastify) server that talks to
PostgreSQL, plus a React web UI. It runs as `npm run dev` (development), `npm run build && npm start`
(production, served on http://localhost:5555), and is packaged as a desktop app (Electron, `desktop/`).

## Layout

```
shared/types.ts            Core API contract (server ⇄ web). Feature types go in shared/<feature>.ts
server/src/
  index.ts                 Fastify bootstrap, error handler, static hosting of web/dist
  db.ts                    Pools per (connection, database), persistent editor sessions, cancel, helpers:
                           queryRows(), withClient(), withTransaction(), getPool()
  query.ts                 SQL execution engine (statement splitting, cursors, maxRows, notices, errors)
  store.ts                 Saved connections (~/.tuplor/connections.json, AES-GCM encrypted passwords)
  lib/sql.ts               quoteIdent / quoteLiteral / qualified / splitStatements
  lib/errors.ts            HttpError, toQueryError (pg error → QueryError)
  lib/paths.ts             DATA_DIR (~/.tuplor or $TUPLOR_HOME), readJson/writeJson
  routes/index.ts          Registers every route module
  routes/connections.ts    CRUD/test/connect                     (core)
  routes/query.ts          POST /api/c/:connId/db/:db/query, cancel, sessions   (core)
  routes/meta.ts           schemas / objects / columns for explorer (core)
  routes/<feature>.ts      One module per feature team (see Ownership)
web/src/
  App.tsx, main.tsx        Shell composition
  styles.css               Design tokens (light/dark). Use semantic Tailwind colors only.
  components/ui/           Design system: Button, IconButton, Input, Select, Field, Dialog, DropdownMenu,
                           ContextMenu, Tooltip, Badge, Switch, Checkbox, Segmented, Toolbar, EmptyState, Spinner, Kbd, toast
  components/grid/         DataGrid (virtualized), cell rendering, export utilities
  components/SqlBlock.tsx  Read-only highlighted SQL with copy button
  lib/api.ts               http helpers, api.* core calls, runSql(), dbUrl()
  lib/format.ts            formatBytes/Duration/Count, quoteIdent/qualified/quoteLiteral (client side), uid, modKey
  lib/monaco.ts            Local Monaco bundle + tuplor-dark/light themes
  lib/queryClient.ts       TanStack Query client + invalidateDb()
  stores/workspace.ts      Tabs (kinds & params documented there), active connection/db, newQuery()
  stores/connections.ts    Saved connections + live connection state (ServerInfo)
  stores/settings.ts       User settings (persisted)
  stores/dialogs.tsx       await confirm(...), await confirmSql({ title, sql }), await prompt(...)
  shell/                   TopBar, TabBar, TabContent, StatusBar, CommandPalette, commands.ts (registerCommands)
  features/registry.tsx    Tab kind → lazy component
  features/<feature>/      One folder per feature team
```

## Conventions

* **API routes**: database-scoped endpoints live under `/api/c/:connId/db/:db/<feature>/...`;
  server-scoped under `/api/c/:connId/<feature>/...`. Throw `HttpError(status, msg)` for client
  errors; pg errors are turned into `{ error: QueryError }` with HTTP 400 automatically.
* **SQL safety**: always use parameters (`$1`) for values and `quoteIdent()` for identifiers.
  Never interpolate user input raw.
* **Values** coming back from `/query` keep PostgreSQL text formatting (int8/numeric/timestamps
  are strings; bool → boolean; int2/int4/oid → number; NULL → null).
* **DDL / data changes initiated from UI**: build the SQL, show it with `confirmSql()` (user can
  review), execute, `toast.success(...)`, then `invalidateDb(connId, db)` so the explorer refreshes.
* **UI**: only semantic colors (`bg-bg`, `bg-panel`, `bg-elevated`, `text-fg`, `text-muted`,
  `text-subtle`, `border-border`, `bg-accent`, `bg-accent-soft`, `text-danger` …) so light & dark
  both work. Base font 13px; toolbars use `<Toolbar>`; icons from `lucide-react` at size 13–16.
  Every view needs loading, empty and error states. Destructive actions are red + confirmed.
* **Tabs**: components receive `{ tab, active }`; tabs stay mounted while hidden. Persist small
  view state in `tab.params` via `useWorkspace.getState().updateParams(tab.id, {...})`.
  Open other views with `useWorkspace.getState().openTab({ kind, title, connId, database, key, params })`.
* **Data fetching**: TanStack Query; key conventions in `lib/queryClient.ts`.
* **Commands**: add palette entries with `registerCommands([...])` from your feature module.

## Ownership (one team per area — do not edit other teams' files)

| Team | Owns |
|---|---|
| Commander (core) | `shared/types.ts`, `server/src/{index,db,query,store}.ts`, `server/src/lib/*`, `routes/{index,connections,query,meta}.ts`, `web/src/{App,main}.tsx`, `styles.css`, `components/ui/*`, `components/SqlBlock.tsx`, `lib/*` (except monaco.ts), `stores/*`, `shell/*`, `features/{registry.tsx,common,welcome,settings,connections}` |
| Data Grid & Table Data | `web/src/components/grid/**`, `web/src/features/table-data/**`, `server/src/routes/tableData.ts`, `shared/tableData.ts` |
| SQL Editor & Explain | `web/src/features/sql-editor/**`, `web/src/features/explain/**`, `web/src/lib/monaco.ts`, `server/src/routes/completion.ts`, `shared/completion.ts` |
| Explorer & Structure | `web/src/features/explorer/**`, `web/src/features/structure/**`, `server/src/routes/schema.ts`, `shared/schema.ts` |
| Monitoring & Admin | `web/src/features/dashboard/**`, `web/src/features/roles/**`, `server/src/routes/{monitor,roles}.ts`, `shared/{monitor,roles}.ts` |
| ERD & Backup | `web/src/features/erd/**`, `web/src/features/backup/**`, `server/src/routes/{erd,backup}.ts`, `shared/{erd,backup}.ts` |
| Desktop & Release | `desktop/**`, `scripts/**` (except demo.sql), root `package.json` scripts (additive) |

If you need a change in a core file, keep it **small and additive** (new export, new optional field)
and list it explicitly in your final report.

## Local test database

`createdb tuplor_demo && psql -d tuplor_demo -f scripts/demo.sql` — schemas `shop`, `analytics`,
`public`; enums, domains, jsonb, arrays, bytea, partitioned table, views, materialized view, functions,
procedure, trigger, table without PK, 60k orders. On this machine PostgreSQL 18 listens on the Unix
socket `/tmp` (connect with host `/tmp`, user = OS user, no password).
