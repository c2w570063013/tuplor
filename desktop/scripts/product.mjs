// Single source of truth for the product identity used by the build/release scripts.
//
// Everything comes from desktop/package.json:
//   productName  → app name, artifact file names, LICENSE / copyright holder
//   version      → app version, release tag (v<version>)
//   repository   → GitHub "owner/repo" for release links and the in-app update check
//
// Renaming the product = change `productName` (and `build.appId`) there, then run
// `npm run license` at the repo root to regenerate LICENSE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = path.resolve(desktopDir, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

export const productName = pkg.productName;
export const version = pkg.version;
/** File-name safe form of the product name: "Tuplor" → "Tuplor". */
export const productSlug = productName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/** "owner/repo" parsed from package.json `repository`, or null while it is still a placeholder. */
export const repoSlug = (() => {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url || '');
  if (!m || /^OWNER$/i.test(m[1]) || /^REPO$/i.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
})();

/** Year the project's copyright starts. */
export const copyrightYear = 2026;
export const copyrightHolder = `The ${productName} authors`;
export const copyright = `Copyright © ${copyrightYear} ${copyrightHolder}`;

/** Release asset names. `alias` names never change between versions (…/releases/latest/download/<alias>). */
export function artifactNames(ext, arch = 'arm64') {
  return {
    versioned: `${productSlug}-${version}-mac-${arch}.${ext}`,
    alias: `${productSlug}-mac-${arch}.${ext}`,
  };
}
