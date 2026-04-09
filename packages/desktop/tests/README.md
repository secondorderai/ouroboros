# Desktop Test Layers

The desktop app test suite is split into 4 layers:

- `renderer-contract.spec.ts`: renderer-only contract checks using `__ouroborosTest` hooks.
- `real-flows.spec.ts`: full user flows against a mock CLI speaking real JSON-RPC over stdin/stdout.
- `main-process.spec.ts`: lifecycle and Electron main-process integration coverage.
- `scripts/electron-cdp-smoke.sh`: manual CDP smoke harness for launch, restart, and packaged-app checks.

## Running

From [packages/desktop](/Users/henry/workspace/ouroboros/packages/desktop):

```bash
bun run build:vite
bun run test:e2e:contracts
bun run test:e2e:real
bun run test:e2e
```

CDP smoke checks are separate because they need `curl`, `jq`, and `websocat` or `wscat`:

```bash
bun run test:cdp:smoke
```

## Manual Release Matrix

Before release, verify on macOS 13/14/15 and Windows 10/11:

- Visual pass: title bar, theme switching, markdown rendering, sidebar, palette, drawer.
- Native pass: file dialogs, workspace picker, external links, window bounds restore.
- Packaging pass: installer launch, update banner behavior, rollback prompt.
- Resilience pass: startup during CLI failure, restart during active chat, no API keys in logs.
