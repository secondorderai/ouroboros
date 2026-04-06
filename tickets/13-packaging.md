# Packaging, Signing & Auto-Update

**Phase:** 3.6 — Packaging & Release
**Type:** Infrastructure
**Priority:** P0
**Depends on:** All previous tickets (02-12)
**Repo:** `packages/desktop/`

## Context

The final ticket transforms the development app into distributable, signed installers for macOS and Windows with automatic update support. This includes bundling the CLI binary, code signing, notarization, and setting up the update infrastructure.

## Requirements

### CLI Binary Bundling

- Compile the Ouroboros CLI into a standalone binary using `bun build --compile` (from `packages/cli/`)
- Include the binary in the desktop app's `resources/` directory
- At runtime, the CLI process manager (ticket 03) resolves the binary path:
  - **Development:** Use `OUROBOROS_CLI_PATH` env var or a configured path
  - **Production:** `path.join(process.resourcesPath, 'ouroboros')` (macOS/Linux) or `path.join(process.resourcesPath, 'ouroboros.exe')` (Windows)
- The bundled CLI version is recorded in the app's `package.json` as `cliVersion`

### electron-builder Configuration

**`electron-builder.yml`:**

```yaml
appId: com.ouroboros.desktop
productName: Ouroboros
directories:
  output: dist

mac:
  category: public.app-category.developer-tools
  target:
    - target: dmg
      arch: [universal]
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  icon: resources/icon.icns

win:
  target:
    - target: nsis
    - target: zip
  icon: resources/icon.ico

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

extraResources:
  - from: resources/cli/
    to: .
    filter:
      - ouroboros*

publish:
  provider: github
  owner: <github-owner>
  repo: ouroboros
```

### macOS Signing & Notarization

- Code sign with Apple Developer ID Application certificate
- Hardened runtime enabled with entitlements:
  - `com.apple.security.cs.allow-jit` (for the CLI child process)
  - `com.apple.security.cs.allow-unsigned-executable-memory`
  - `com.apple.security.automation.apple-events` (for folder picker)
- Notarize with `notarytool` via electron-builder's `afterSign` hook
- Verify: `spctl --assess --type execute` passes on the built `.app`
- Universal binary (arm64 + x64) for Apple Silicon and Intel Macs

### Windows Signing

- Sign with an EV code signing certificate
- Sign the NSIS installer and the main executable
- Timestamp the signature for long-term validity

### Auto-Update

- Use `electron-updater` with GitHub Releases as the update provider
- **Check schedule:** On app launch, non-blocking. Max once per 24 hours (use a timestamp in electron-store).
- **Download:** Background download, does not interrupt the user
- **Notification:** Non-intrusive banner at the top of the app: "Update available (v1.2.0). Restart to apply." Dismiss button + "Restart now" button.
- **Apply:** On user-initiated restart, replace the app and relaunch
- **Crash rollback:** If the app crashes 3 times within 60 seconds of launching a new version, show a dialog offering to download the previous version
- **Release channels:** Just "latest" for now. No beta/canary channels.

### Build Artifacts

| Platform | Artifact | Notes |
|----------|----------|-------|
| macOS | `Ouroboros-{version}-universal.dmg` | Drag-to-Applications installer |
| Windows | `Ouroboros-Setup-{version}.exe` | NSIS installer |
| Windows | `Ouroboros-{version}-portable.zip` | No install required |

### CI/CD Pipeline

Set up GitHub Actions workflows:

- **`build.yml`:** On push to main — build unsigned artifacts for both platforms, run E2E tests
- **`release.yml`:** On tag push (e.g., `v1.0.0`) — build signed artifacts, notarize macOS, create GitHub Release with assets, publish update metadata

### Performance & Size

- Target bundle size < 100MB compressed (excluding CLI binary)
- CLI binary adds ~30-50MB depending on platform
- Total installer size target: < 150MB

### E2E Test Suite

Before release, the automated test suite (Playwright + Electron) must pass:

- App launches and shows onboarding (or chat if already onboarded)
- Theme toggle works
- CLI process spawns and responds to health check
- A message can be sent and a response received (with mock CLI)
- Command palette opens and searches
- Settings overlay opens and closes
- Sidebar toggles

## Scope Boundaries

- No Linux builds (deferred to Phase 4)
- No app store distribution (macOS App Store, Windows Store) — direct download only
- No delta updates — full app replacement on update
- No beta/canary release channels
- Code signing certificates are assumed to already exist — this ticket configures their use, not their procurement

## Acceptance Criteria

- [ ] `npm run build:mac` produces a signed, notarized `.dmg` for macOS (universal)
- [ ] `npm run build:win` produces a signed `.exe` installer and `.zip` for Windows
- [ ] CLI binary is bundled in `resources/` and the app uses it at runtime
- [ ] macOS app passes `spctl --assess` (Gatekeeper approved)
- [ ] Auto-update checks on launch and shows notification when available
- [ ] Update downloads in background and applies on restart
- [ ] Crash rollback offers previous version after 3 rapid crashes
- [ ] E2E test suite passes on both platforms in CI
- [ ] GitHub Actions builds and publishes releases on tag push
- [ ] Total installer size < 150MB per platform

## Feature Tests

- **Test: macOS DMG installs correctly**
  - **Setup:** Download the `.dmg`. Drag to Applications.
  - **Action:** Launch from Applications.
  - **Expected:** App opens without Gatekeeper warning. CLI spawns and responds.

- **Test: Windows installer runs correctly**
  - **Setup:** Download the `.exe`. Run the installer.
  - **Action:** Launch from Start Menu.
  - **Expected:** App opens. CLI spawns and responds.

- **Test: Auto-update notification**
  - **Setup:** Current app version is 1.0.0. GitHub Release has 1.1.0.
  - **Action:** Launch the app.
  - **Expected:** After a few seconds, banner appears: "Update available (v1.1.0). Restart to apply."

- **Test: Update apply**
  - **Setup:** Update notification is showing. Click "Restart now".
  - **Expected:** App restarts with the new version.

- **Test: CLI binary resolution**
  - **Setup:** Production build.
  - **Action:** App launches and spawns CLI.
  - **Expected:** CLI binary found at `resources/ouroboros`. Health check passes.

- **Test: Portable Windows build**
  - **Setup:** Extract the `.zip` to a folder.
  - **Action:** Run `Ouroboros.exe`.
  - **Expected:** App launches without installation. Settings stored in the app's folder.

## Notes

- For CI, use `macos-latest` and `windows-latest` GitHub Actions runners. macOS signing requires the certificate to be imported into the keychain in CI (use a GitHub secret for the base64-encoded `.p12`).
- The notarization step can take 2-10 minutes. Cache the notarization result if possible.
- The CLI binary must be compiled for the target platform. The macOS universal binary needs both arm64 and x64 CLI binaries (or a universal Bun binary). The CI pipeline should compile the CLI binary as a step before the Electron build.
- For the crash rollback, use electron-store to count rapid crashes (launches within 60s of each other). Reset the counter on successful startup (e.g., after 60s of uptime).
