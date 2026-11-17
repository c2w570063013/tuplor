# Website

The product & download site, built with [Astro](https://astro.build) and deployed to
GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every
push to `main` that touches `site/**`.

English is served at `/`, Traditional Chinese at `/zh-TW/`.

## Develop

Requires Node.js 22.12+ (CI uses Node 24). The site is a standalone npm project — it is
**not** part of the root workspaces, so install it on its own:

```bash
cd site
npm install
npm run dev        # http://localhost:4321/REPO/  (hot reload)
```

## Build & preview

```bash
npm run build      # → site/dist (static files)
npm run preview    # serves dist at http://localhost:4321/REPO/
```

Use `npm run preview -- --port 4391` to pick another port.

## Rename / release checklist

Everything brand-related lives in **[`src/config.ts`](src/config.ts)**:

| Field | What it controls |
|---|---|
| `name` | Product name everywhere: titles, hero, copy (`{name}` in `src/i18n/*.ts`), OG image |
| `tagline.en` / `tagline['zh-TW']` | Hero subtitle and OG image text |
| `owner`, `repo` | All GitHub links, download URLs, clone command |
| `version` | Version shown under the download button |
| `downloads.macArm64` | Release asset file name |
| `siteUrl`, `basePath` | Canonical URLs for local builds (CI detects them automatically) |

The download button links to

```
https://github.com/<owner>/<repo>/releases/latest/download/<downloads.macArm64>
```

so the release workflow must upload an asset with **exactly** that name (no version in it)
to every release.

The OG image (`/og.png`) and PNG favicons are generated at build time from `config.ts`
(see `src/lib/brand-images.ts`), so they follow a rename automatically. The favicon /
logo mark (`public/favicon.svg`, `src/components/Logo.astro`) is a generic database glyph
with no text.

## Custom domain

1. Set the domain in the repository's Settings → Pages.
2. Add `site/public/CNAME` containing the domain (e.g. `pgstudio.dev`).
3. In `src/config.ts` set `siteUrl: 'https://pgstudio.dev'` and `basePath: '/'`.

The workflow reads the real base path from GitHub (`actions/configure-pages`), so it
needs no change.

## Screenshots

`src/assets/screens/<view>-<dark|light>.png` are real captures of the app at 1440×900
(2× DPR) connected to the `pgstudio_demo` database (`scripts/demo.sql`). Astro converts
them to AVIF + WebP with a PNG fallback at build time; the page shows the dark or light
set to match the visitor's theme.

To re-capture: build the app, start it with an empty data dir so no personal
connections appear (`PORT=5601 PGSTUDIO_HOME=$(mktemp -d) npm start`), add one
connection named "Demo" to `pgstudio_demo`, and capture the same six views
(SQL editor with autocomplete open, data grid with staged edits, EXPLAIN ANALYZE,
ER diagram of `shop`, server dashboard, New connection dialog) in both themes.
Never commit edits to the demo data. Hide other databases/roles on the server and your
OS user name before capturing.

## Structure

```
src/config.ts            brand / repo / version / download names (edit me)
src/i18n/en.ts           English copy
src/i18n/zh-TW.ts        Traditional Chinese copy (same shape, type-checked)
src/components/Home.astro  the whole landing page, rendered for each language
src/layouts/Layout.astro   <head>: SEO, hreflang, OpenGraph, theme bootstrap
src/lib/brand-images.ts  build-time OG image + PNG favicons (sharp)
src/pages/               index (en), zh-TW/index, 404, og.png, robots.txt, favicons
src/styles/global.css    design tokens (light/dark) and styles
```
