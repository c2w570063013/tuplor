#!/usr/bin/env node
// Packages the staged app (desktop/out) with electron-builder: macOS arm64 .dmg + .zip.
//
// Signing is decided by the environment, so the same command works everywhere:
//
//   no CSC_LINK / CSC_NAME          → ad-hoc signed, no hardened runtime, not notarized
//                                     (local builds, and CI until the Apple secrets exist)
//   CSC_LINK (+ CSC_KEY_PASSWORD)   → Developer ID signed, hardened runtime + entitlements
//   or CSC_NAME (keychain identity)
//   … + APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER        → also notarized + stapled
//   … or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID    → (alternative)
//   … or APPLE_KEYCHAIN_PROFILE (notarytool store-credentials)   → (alternative, local only)
//
// APPLE_API_KEY may be a path to the AuthKey_XXXX.p8 file, or the key's contents (as stored in a
// GitHub secret); contents are written to a private temp file for the duration of the build.
// Empty variables count as unset (GitHub passes missing secrets as "").
//
// Flags: --hardened   ad-hoc build WITH hardened runtime + entitlements (tests the entitlements
//                     locally without a certificate; such a build is not distributable).
//
// Writes desktop/release/build-info.json ({ version, signed, notarized, … }) for the release job.
import { Arch, Platform, build } from 'electron-builder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactNames, copyright, desktopDir, productName, productSlug, version } from './product.mjs';

const SIGNING_VARS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
];
for (const k of SIGNING_VARS) if (!process.env[k]?.trim()) delete process.env[k];
const env = process.env;

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};
const all = (...keys) => keys.every((k) => env[k]);
const any = (...keys) => keys.some((k) => env[k]);

const API_KEY_VARS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const APPLE_ID_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
if (any(...API_KEY_VARS) && !all(...API_KEY_VARS)) die(`notarization: set all of ${API_KEY_VARS.join(', ')} (or none).`);
if (any(...APPLE_ID_VARS) && !all(...APPLE_ID_VARS)) die(`notarization: set all of ${APPLE_ID_VARS.join(', ')} (or none).`);

const hasCert = any('CSC_LINK', 'CSC_NAME');
let notaryMethod = all(...API_KEY_VARS) ? 'api-key' : all(...APPLE_ID_VARS) ? 'apple-id' : env.APPLE_KEYCHAIN_PROFILE ? 'keychain-profile' : null;
const hardenedAdhoc = process.argv.includes('--hardened');

let tmpKeyDir = null;
if (notaryMethod === 'api-key') {
  // electron-builder prefers APPLE_ID when both are present; we prefer the API key.
  for (const k of APPLE_ID_VARS) delete env[k];
  if (!fs.existsSync(env.APPLE_API_KEY)) {
    let key = env.APPLE_API_KEY.replace(/\\n/g, '\n');
    if (!key.includes('BEGIN PRIVATE KEY')) key = Buffer.from(key, 'base64').toString('utf8');
    if (!key.includes('BEGIN PRIVATE KEY')) die('APPLE_API_KEY is neither a path to a .p8 file nor the contents of one.');
    tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notary-'));
    const file = path.join(tmpKeyDir, `AuthKey_${env.APPLE_API_KEY_ID}.p8`);
    fs.writeFileSync(file, key.trim() + '\n', { mode: 0o600 });
    env.APPLE_API_KEY = file;
  }
}

const config = {
  copyright,
  mac: { artifactName: `${productSlug}-\${version}-mac-\${arch}.\${ext}` },
};

let mode;
if (hasCert) {
  mode = notaryMethod ? `Developer ID signed + notarized (${notaryMethod})` : 'Developer ID signed, NOT notarized';
  config.forceCodeSigning = true; // never silently fall back to an unsigned release
  config.mac.notarize = !!notaryMethod;
  if (!notaryMethod) console.warn('⚠ No notarization credentials: Gatekeeper will still block downloaded copies.');
} else {
  if (notaryMethod) console.warn('⚠ Notarization credentials found but no certificate (CSC_LINK / CSC_NAME): skipping notarization.');
  notaryMethod = null;
  mode = hardenedAdhoc ? 'ad-hoc signed, hardened runtime (test only)' : 'ad-hoc signed (unsigned build)';
  config.mac.identity = '-';
  config.mac.notarize = false;
  if (!hardenedAdhoc) config.mac.hardenedRuntime = false;
}
console.log(`→ packaging ${productName} ${version}: ${mode}`);

const releaseDir = path.join(desktopDir, 'release');
let artifacts;
try {
  artifacts = await build({
    projectDir: desktopDir,
    targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
    publish: 'never',
    config,
  });
} catch (e) {
  die(e?.message || String(e));
} finally {
  if (tmpKeyDir) fs.rmSync(tmpKeyDir, { recursive: true, force: true });
}

const files = artifacts.filter((f) => /\.(dmg|zip)$/.test(f)).map((f) => path.basename(f));
for (const ext of ['dmg', 'zip']) {
  if (!files.includes(artifactNames(ext).versioned)) die(`expected ${artifactNames(ext).versioned}, got: ${files.join(', ')}`);
}
fs.writeFileSync(
  path.join(releaseDir, 'build-info.json'),
  JSON.stringify(
    { productName, version, arch: 'arm64', signed: hasCert, notarized: hasCert && !!notaryMethod, mode, files },
    null,
    2,
  ) + '\n',
);
