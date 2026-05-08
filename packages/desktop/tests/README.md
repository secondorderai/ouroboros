# Desktop Test Layers

The desktop app test suite covers the Electron shell, renderer contracts, and
mocked CLI JSON-RPC behavior.

- `renderer-contract.spec.ts`: renderer-only contract checks using
  `__ouroborosTest` hooks for onboarding, settings, protocol notifications,
  skills, modes, approvals, artifacts, and chat state.
- `renderer-contract-runtime.spec.ts`: runtime renderer contract checks that
  need the built renderer bundle.
- `real-flows.spec.ts`: full user flows against a mock CLI speaking real
  JSON-RPC over stdin/stdout.
- `main-process.spec.ts`: lifecycle and Electron main-process integration,
  including CLI launch/restart and native integration boundaries.
- `artifact-panel.spec.ts`: artifact list/read/preview behavior, hide/show,
  fullscreen, save/open actions, and artifact-created auto-open behavior.
- `team-graph.spec.ts`: team graph notifications and renderer state.
- `steering.spec.ts`: mid-turn steering lifecycle states.
- `mermaid-*.spec.ts`: Mermaid rendering, theme, zoom, and lightbox behavior.
- `test-plan/*.md` + `.agents/skills/ouroboros-intent-e2e`: intent-based
  E2E charters driven through Agent Browser and Electron CDP.
- `scripts/electron-cdp-smoke.sh`: manual CDP smoke harness for launch,
  restart, and packaged-app checks.

## Running

From [packages/desktop](/Users/henry/workspace/ouroboros/packages/desktop):

```bash
bun run build:vite
bun run test:e2e:contracts
bun run test:e2e:real
bun run test:e2e
```

Intent E2E is an opt-in layer while it stabilizes:

```bash
bun run test:intent:e2e -- test-plan/desktop-onboarding-chat.md --dry-run
bun run test:intent:e2e -- test-plan/desktop-onboarding-chat.md
```

Electron windows are hidden by default during E2E runs so local tests do not steal focus or cover
your workspace. To debug visually, run a specific test with:

```bash
OUROBOROS_TEST_HIDE_WINDOW=0 npx playwright test tests/e2e/renderer-contract.spec.ts -g "test name"
```

CDP smoke checks are separate because they need `curl`, `jq`, and `websocat` or `wscat`:

```bash
bun run test:cdp:smoke
```

## Manual Release Matrix

Before release, verify on macOS 13/14/15:

- Visual pass: title bar, theme switching, markdown rendering, sidebar, palette, drawer.
- Native pass: file dialogs, workspace picker, artifact save/open, external links, window bounds restore.
- Packaging pass: DMG install, app launch, update banner behavior, rollback prompt.
- Resilience pass: startup during CLI failure, restart during active chat, no API keys in logs.
- Protocol pass: settings skills, disabled skill state, modes, steering, approvals, subagent rows, team graph, artifact panel, RSI history, and MCP status notifications.
