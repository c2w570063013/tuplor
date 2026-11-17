/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Site / brand configuration — the ONLY file to edit for a rename or release.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Product rename  → change `name` (and `fileBase` if the .dmg name changes).
 *  GitHub repo     → change `owner` / `repo`.
 *  New release     → change `version` (shown in the hero; downloads always
 *                    point at /releases/latest so they need no change).
 *  Custom domain   → change `siteUrl` to "https://example.com" and `basePath`
 *                    to "/" (also add site/public/CNAME, see site/README.md).
 *
 *  Translated copy lives in src/i18n/*.ts and refers to the product as
 *  `{name}`, so it follows `name` automatically.
 */

export const SITE = {
  /** Product name, used everywhere on the site (titles, hero, OG image, copy). */
  name: 'PG Studio',

  /** One-line taglines per language (hero subtitle, <meta description> lead, OG image). */
  tagline: {
    en: 'A fast, beautiful and free PostgreSQL GUI for macOS.',
    'zh-TW': '免費、介面優美、功能完整的 PostgreSQL 管理工具。',
  },

  /** GitHub owner (user or org) and repository name. */
  owner: 'OWNER',
  repo: 'REPO',

  /** Latest released version, shown next to the download button. */
  version: '0.1.0',

  /**
   * Release asset names. The release workflow must upload files with exactly
   * these names so that /releases/latest/download/<file> keeps working.
   */
  downloads: {
    macArm64: 'PG-Studio-mac-arm64.dmg',
  },

  /** License shown in hero + footer. */
  license: 'MIT',

  /**
   * Where the site is served. Defaults to a GitHub *project* page:
   *   https://OWNER.github.io/REPO/
   * Both can be overridden at build time with SITE_URL / BASE_PATH env vars
   * (the Pages workflow does this automatically from the repository name).
   */
  siteUrl: 'https://OWNER.github.io',
  basePath: '/REPO/',
} as const;

export type Lang = 'en' | 'zh-TW';

export const repoUrl = `https://github.com/${SITE.owner}/${SITE.repo}`;
export const links = {
  repo: repoUrl,
  releases: `${repoUrl}/releases`,
  latestRelease: `${repoUrl}/releases/latest`,
  changelog: `${repoUrl}/releases`,
  issues: `${repoUrl}/issues`,
  newIssue: `${repoUrl}/issues/new`,
  license: `${repoUrl}/blob/main/LICENSE`,
  readme: `${repoUrl}#readme`,
  /** Direct download of the newest macOS Apple Silicon build. */
  macArm64: `${repoUrl}/releases/latest/download/${SITE.downloads.macArm64}`,
} as const;
