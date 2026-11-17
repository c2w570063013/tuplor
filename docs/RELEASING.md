# Releasing the desktop app

The desktop app ships as a macOS **Apple Silicon (arm64)** `.dmg` and `.zip` on GitHub Releases.
A tag push builds it on a GitHub-hosted Mac (`.github/workflows/release.yml`), signs and
notarizes it when the Apple credentials are configured, and publishes the release.

Without credentials everything still works: the build is **ad-hoc signed and not notarized**,
and users have to right-click → **Open** the first time. Signing switches on as soon as the
GitHub secrets below exist; no code or config change is needed.

## Where things are configured

| What | Where |
|---|---|
| Product name (app name, file names, LICENSE holder) | `desktop/package.json` → `productName` |
| App version (= release tag without the `v`) | `desktop/package.json` → `version` |
| GitHub repo for the in-app update notice | `desktop/package.json` → `repository` (`https://github.com/<owner>/<repo>`) |
| Bundle ID | `desktop/package.json` → `build.appId` |
| Signing / notarization switch | `desktop/scripts/dist.mjs` (reads env vars) |
| Hardened-runtime entitlements | `desktop/build/entitlements.mac.plist` |
| Release asset names | `desktop/scripts/product.mjs` → `artifactNames()` |

After renaming the product, run `npm run license` to regenerate `LICENSE` (CI fails if it is stale).
Note that changing `build.appId` makes macOS treat the app as a different app (new
`~/Library/Application Support/<productName>` folder), so do it before the first public release.

**Before the first release**, replace the placeholder `https://github.com/OWNER/REPO` in
`desktop/package.json` → `repository` with the real repository URL. While it is a placeholder
the app skips the update check.

## Release assets

Every release has these files (`<Slug>` is `productName` with spaces replaced by `-`, e.g. `PG-Studio`):

| File | Purpose |
|---|---|
| `<Slug>-<version>-mac-arm64.dmg` | Versioned installer |
| `<Slug>-<version>-mac-arm64.zip` | Versioned zip of the `.app` (Homebrew cask, manual installs) |
| `<Slug>-mac-arm64.dmg` | Same dmg under a stable name |
| `<Slug>-mac-arm64.zip` | Same zip under a stable name |
| `SHA256SUMS.txt` | Checksums of the four files above |

Stable download links for the website (always the newest non-prerelease release):

```
https://github.com/<owner>/<repo>/releases/latest/download/<Slug>-mac-arm64.dmg
https://github.com/<owner>/<repo>/releases/latest/download/<Slug>-mac-arm64.zip
```

## One-time setup: Apple signing + notarization

You need a paid Apple Developer Program membership. Nothing in this repo ever contains these
credentials: they live only in your Keychain, your password manager and GitHub secrets.

1. **Join the Apple Developer Program** at <https://developer.apple.com/programs/> and wait
   until the membership is active. Note your **Team ID** (Membership details page, 10 characters).

2. **Create a "Developer ID Application" certificate.**
   - On your Mac open **Keychain Access → Certificate Assistant → Request a Certificate From a
     Certificate Authority…**, enter your email, choose *Saved to disk*.
   - At <https://developer.apple.com/account/resources/certificates/add> choose
     **Developer ID Application** (not "Apple Development", not "Mac App Distribution"),
     upload the request, download the `.cer` and double-click it to install it in your login keychain.
   - Check: `security find-identity -v -p codesigning` lists
     `Developer ID Application: <Your Name> (<TEAMID>)`.

3. **Export it as a `.p12`.** In Keychain Access → *My Certificates*, expand the
   Developer ID Application certificate, select the certificate **and** its private key,
   right-click → **Export 2 items…** → `.p12`, and set a strong export password.
   Then base64-encode it for GitHub:

   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```

4. **Create an App Store Connect API key** (used by `notarytool`).
   At <https://appstoreconnect.apple.com/access/integrations/api> → *Team Keys* → **+**,
   give it the **Developer** role. Note the **Key ID** and the **Issuer ID** shown above the
   table, and download `AuthKey_<KEYID>.p8` (it can be downloaded only once — keep it safe).

5. **Add the GitHub secrets.** Repository → *Settings → Secrets and variables → Actions →
   New repository secret*:

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | the base64 text of the `.p12` from step 3 |
   | `CSC_KEY_PASSWORD` | the `.p12` export password |
   | `APPLE_API_KEY` | the full contents of `AuthKey_<KEYID>.p8` (including the `-----BEGIN PRIVATE KEY-----` lines) |
   | `APPLE_API_KEY_ID` | the Key ID from step 4 |
   | `APPLE_API_ISSUER` | the Issuer ID from step 4 |

   *Alternative to the API key* (use one or the other, not both): `APPLE_ID` (your Apple ID
   email), `APPLE_APP_SPECIFIC_PASSWORD` (create one at <https://account.apple.com> → Sign-In and
   Security → App-Specific Passwords) and `APPLE_TEAM_ID`. If both sets exist, the API key wins.

   With only `CSC_LINK` + `CSC_KEY_PASSWORD` the app is signed but not notarized, which
   Gatekeeper still blocks for downloaded copies — set the notarization secrets too.

## Cutting a release

1. Bump the version in `desktop/package.json` (this is the version the app reports):

   ```bash
   cd desktop && npm version 0.2.0 --no-git-tag-version && cd ..
   ```

2. Commit, tag and push (the tag must be `v` + that exact version, or the workflow stops):

   ```bash
   git commit -am "Release v0.2.0"
   ```

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin main v0.2.0
   ```

3. Watch **Actions → Release**. When it finishes, the release is live with the assets above and
   auto-generated notes; edit the notes on GitHub if you like. Running apps see the update notice
   within a day (the app checks GitHub at most once every 24 hours, on launch).

A tag with a suffix (`v0.2.0-beta.1`) is published as a **pre-release**; it does not become
"latest", so the website links and the in-app notice ignore it.

To redo a failed release: delete the release and the tag on GitHub (`git push --delete origin v0.2.0`,
`git tag -d v0.2.0`), fix, and tag again.

## Building locally

```bash
npm run desktop:build
```

builds `desktop/release/mac-arm64/<productName>.app` plus the dmg and zip. Without signing env vars
it is ad-hoc signed, exactly like before. `npm run desktop:smoke` runs an end-to-end check of the
packaged app (quit any running copy of the app first: it holds a single-instance lock), and
`npm run desktop:assets` prepares the release files (aliases + `SHA256SUMS.txt`) in
`desktop/release/assets/`.

### Signed + notarized local build

With the Developer ID certificate in your login keychain, store notarization credentials in the
keychain once (it prompts for the values; nothing is written to the repo):

```bash
xcrun notarytool store-credentials notary --key ~/keys/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Then build with:

```bash
CSC_NAME="Developer ID Application: Your Name (TEAMID)" APPLE_KEYCHAIN_PROFILE=notary npm run desktop:build
```

Instead of `CSC_NAME` you can use `CSC_LINK=/path/to/DeveloperID.p12` + `CSC_KEY_PASSWORD`, and
instead of the keychain profile the same `APPLE_API_KEY` (a path to the `.p8` works) /
`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` variables as in CI.

Check the result:

```bash
codesign --verify --deep --strict --verbose=2 "desktop/release/mac-arm64/PG Studio.app"
```

```bash
spctl --assess --type execute --verbose=4 "desktop/release/mac-arm64/PG Studio.app"
```

(`spctl` should say `source=Notarized Developer ID`; adjust the app name if you renamed it.)

### Testing the entitlements without a certificate

`npm run desktop:build -- --hardened` makes an ad-hoc signed build **with** the hardened runtime
and `desktop/build/entitlements.mac.plist`, which is how a signed build runs. If it launches and
`npm run desktop:smoke` passes, the entitlements are sufficient. Don't distribute that build.

## How signing is decided

`desktop/scripts/dist.mjs` runs electron-builder with the base config from `desktop/package.json`
(hardened runtime, entitlements, `notarize: true`) and adjusts it from the environment:

| Environment | Result |
|---|---|
| no `CSC_LINK` / `CSC_NAME` | ad-hoc signed (`identity: "-"`), hardened runtime off, not notarized |
| `CSC_LINK` or `CSC_NAME` | Developer ID signed, hardened runtime; signing failures fail the build |
| + `APPLE_API_KEY`/`_ID`/`_ISSUER`, or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE` | also notarized and stapled |

Empty variables count as unset, so missing GitHub secrets simply mean an unsigned build.
`desktop/release/build-info.json` records what happened; the release notes mention it when a
build is not notarized.

## In-app update notice

On launch (at most once per 24 hours) the desktop app requests
`https://api.github.com/repos/<owner>/<repo>/releases/latest` for the repo in
`desktop/package.json` → `repository`. If that release's tag is a newer `x.y.z` than the running
version, the UI shows a toast with a **Download** button that opens the release page in the
browser. There is no auto-update. Offline, rate-limited or placeholder-repo cases are silent.

For testing: `PGSTUDIO_UPDATE_REPO=owner/repo` checks another repo and ignores the daily limit;
`PGSTUDIO_UPDATE_CHECK=0` disables the check.
