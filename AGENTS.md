# OUROBOROS - Development Instructions

Ouroboros is a recursive self-improving AI agent. It is a Bun/TypeScript
monorepo with a CLI agent, an Electron desktop app, and shared types. Runtime
skills use the Agent Skills `SKILL.md` format.

## Structure

- `packages/cli`: main agent, tools, memory, JSON-RPC server, Bun tests.
- `packages/desktop`: Electron 33 + React 19 UI, main/preload/renderer code,
  Playwright E2E tests, `DESIGN.md` visual system.
- `packages/shared`: shared protocol/types/utilities.
- `skills`, `memory`: runtime data at repo root.
- `docs`, `tickets`: project docs and implementation tickets.

## Architecture

- CLI core loop follows ReAct: plan, act with tools, observe, iterate.
- CLI tools live in `packages/cli/src/tools/`; each exports `name`,
  `description`, Zod `schema`, and async `execute`. Tool execution returns
  `Result<T, Error>` and should not throw.
- Memory has durable, checkpoint, working, transcript, and evolution-log state.
- JSON-RPC mode (`--json-rpc`) is a long-running NDJSON server over stdio.
- Desktop is a presentation layer. It spawns the CLI with `--json-rpc`; renderer
  calls typed preload APIs and must not access Node directly.
- Protocol types in `packages/desktop/src/shared/protocol.ts` are the desktop
  IPC source of truth; update contract tests when changing RPC shapes.
- `AGENTS.md` is loaded from cwd ancestors, root first. `.ouroboros` is runtime
  configuration only, not behavioral prose.

## Conventions

- Use Bun and TypeScript. Each package has its own `tsconfig.json` extending the
  root config.
- Use Zod for runtime validation and composition over inheritance.
- CLI self-modification requires human approval. Keep the 5-tier permission
  model intact.
- Desktop renderer: context isolation enabled, Node integration disabled, all
  IPC through typed preload APIs.
- Desktop styling: use CSS variables from `packages/desktop/DESIGN.md`; avoid
  hardcoded colors. Components use inline styles or CSS files, not CSS-in-JS
  runtimes.
- Shared types are imported as `@ouroboros/shared`.

## Commands

- Root: `bun install`, `bun run verify`, `bun run lint`, `bun run ts-check`.
- CLI: `cd packages/cli && bun test`, `bun run build`, `bun run ts-check`.
- Desktop: `cd packages/desktop && bun run dev`, `bun run build:vite`,
  `bun run ts-check`, `bun run test:e2e`.
- Workspace examples: `bun run --filter @ouroboros/cli test`,
  `bun run --filter @ouroboros/desktop dev`.

## Testing Policy

Every feature, improvement, and bug fix must ship with automated tests that
would catch the regression if reverted. A change without a matching test is
incomplete.

- CLI tool changes: add/update unit tests in `packages/cli/tests/tools/`.
- Agent loop, LLM, memory, or RSI changes: add/update matching
  `packages/cli/tests/` coverage.
- RPC method changes: update `RPC_METHOD_NAMES`; protocol contract tests must
  pass.
- Notification changes: update `NOTIFICATION_METHOD_NAMES`; protocol contract
  tests must pass.
- JSON-RPC transport/server/dispatcher changes: extend
  `packages/cli/tests/integration/json-rpc-transport.test.ts`.
- Desktop main process or IPC changes: add/update E2E in `main-process.spec.ts`
  or `real-flows.spec.ts`.
- Desktop renderer UI changes: add/update E2E in `renderer-contract.spec.ts` or
  a focused spec.
- Zustand store logic: add/update unit tests in `packages/desktop/tests/`.
- Shared package changes: cover behavior from the consuming package, at minimum
  from the CLI side.
- Bug fixes: the new test must fail before the fix and pass after it.

## Verification

After implementation, run `bun run verify` from the repo root before reporting
completion. It runs lint, type checks, CLI tests, and desktop E2E. If any step
fails, fix the issue and rerun. Live LLM tests are manual only:
`bun run test:cli:live`.
