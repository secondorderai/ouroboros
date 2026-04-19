# OUROBOROS — Development Instructions

## Project Overview

Ouroboros is a recursive self-improving AI agent. TypeScript on Bun, structured as
a monorepo with Bun workspaces. It uses the Agent Skills standard (agentskills.io)
for portable skill format. The project ships both a CLI agent and an Electron
desktop app that wraps the CLI via JSON-RPC.

## Monorepo Structure

```
ouroboros/
├── packages/
│   ├── cli/              # @ouroboros/cli — CLI agent (main package)
│   │   ├── src/
│   │   │   ├── tools/    # Tool implementations (auto-discovered)
│   │   │   └── json-rpc/ # JSON-RPC server for desktop app communication
│   │   ├── tests/
│   │   └── package.json
│   ├── desktop/          # @ouroboros/desktop — Electron desktop app
│   │   ├── src/
│   │   │   ├── main/     # Electron main process (CLI spawning, IPC, auto-updater)
│   │   │   ├── renderer/ # React UI (components, views, hooks, stores, styles)
│   │   │   └── shared/   # Types shared between main & renderer (protocol.ts)
│   │   ├── tests/e2e/    # Playwright E2E tests
│   │   ├── electron-builder.yml
│   │   ├── DESIGN.md     # Visual design system (colors, typography, components)
│   │   └── package.json
│   └── shared/           # @ouroboros/shared — Shared types & utilities
│       ├── src/
│       └── package.json
├── .github/workflows/    # CI/CD (build.yml, release.yml)
├── package.json          # Root: Bun workspaces config
├── tsconfig.base.json    # Shared TypeScript settings (packages extend this)
├── skills/               # Runtime data — agent skills (stays at root)
├── memory/               # Runtime data — agent memory (stays at root)
├── docs/
└── tickets/
```

## Tech Stack

### CLI (`packages/cli/`)
- Runtime: Bun (TypeScript)
- LLM: Vercel AI SDK (ai package) — provider-agnostic
- DB: SQLite via bun:sqlite for transcripts
- UI: Commander.js + Ink for rich terminal UI
- Testing: Bun test runner
- Skills: agentskills.io format (SKILL.md with YAML frontmatter)

### Desktop (`packages/desktop/`)
- Framework: Electron 33 + React 19
- Bundler: electron-vite (handles main/preload/renderer build pipeline)
- State: Zustand for conversation and approval stores
- Markdown: react-markdown + remark-gfm + rehype-highlight (highlight.js)
- Scrolling: react-virtuoso for virtualized message lists
- Search: fuse.js for command palette fuzzy matching
- Persistence: electron-store (theme, window bounds, onboarding flag)
- Updates: electron-updater with GitHub Releases
- Packaging: electron-builder (macOS DMG, Windows NSIS+ZIP, Linux AppImage)
- Testing: Playwright for E2E tests
- Design: DESIGN.md in package root defines all visual tokens and component patterns

## Architecture

### CLI
- Core loop: ReAct pattern (plan → act → observe → loop)
- Tools: Registry pattern, auto-discovered from packages/cli/src/tools/
- Memory: 3+1 layers (MEMORY.md index, topic files, SQLite transcripts, evolution
  log)
- RSI: 4 feedback loops (crystallize, self-test, dream, evolve)
- Safety: 5-tier permission model
- JSON-RPC mode: `--json-rpc` flag switches CLI to a long-running server that
  reads NDJSON requests on stdin and writes responses/notifications on stdout

### Desktop
- Pure presentation layer — all intelligence stays in the CLI process
- IPC: Electron main process spawns CLI with `--json-rpc`, communicates via
  JSON-RPC 2.0 over stdin/stdout. Renderer calls `window.ouroboros.rpc()` which
  bridges through the preload script to the main process RPC client.
- Protocol: 19 request methods + 10 notification types defined in
  `src/shared/protocol.ts` (shared between main and renderer)
- CLI process manager: auto-restart on crash (3 retries), health check on startup,
  graceful shutdown with 3s timeout
- Crash rollback: detects 3 rapid crashes within 60s, offers previous version

### Shared types
- Imported as `@ouroboros/shared` across packages

## AGENTS.md compatibility

This repository uses `AGENTS.md` as the canonical human instruction file.

- Ouroboros now discovers `AGENTS.md` from the active working directory upward.
- In nested workspaces, root instructions are loaded first and nearest workspace/package instructions are appended after them.
- `.ouroboros` remains the source for runtime configuration, not behavioral prose instructions.

## Conventions

### CLI
- All tools export: name, description, schema (JSON Schema), execute (async fn)
- Skills conform to agentskills.io spec — validate with skills-ref library
- Every self-modification is git-committed with structured message
- Use Zod for runtime type validation
- Prefer composition over inheritance
- Error handling: all tools return Result<T, Error> — never throw

### Desktop
- Context isolation enabled, Node integration disabled in renderer
- All IPC goes through typed preload APIs (`ElectronAPI`, `OuroborosAPI`)
- All colors reference CSS variables from DESIGN.md — no hardcoded colors
- Components use inline style objects or CSS files — no CSS-in-JS runtime
- Protocol types in `src/shared/protocol.ts` are the single source of truth for
  IPC message shapes

### Both
- Each package has its own tsconfig.json extending root tsconfig.base.json

## Commands

### CLI (`packages/cli/`)

- `bun run dev` — start CLI in development mode
- `bun test` — run all CLI tests
- `bun run build` — build CLI for distribution
- `bun run lint` — run linter (Prettier format check)
- `bun run ts-check` — TypeScript type check
- `bun run test:all` — all tests including live LLM tests

### Desktop (`packages/desktop/`)

- `bun run dev` — start Electron app with Vite dev server
- `bun run build` — build Electron app (Vite + electron-builder, unsigned local)
- `bun run build:mac` — build macOS DMG (universal binary)
- `bun run build:win` — build Windows installer (NSIS + ZIP)
- `bun run build:vite` — build renderer only (no electron-builder packaging)
- `bun run build:cli` — compile CLI binary for bundling into desktop resources
- `bun run ts-check` — TypeScript type check (all 3 tsconfig projects: main, node, web)
- `bun run test:e2e` — end-to-end tests (Playwright + Electron)

### Root (workspace-level)

- `bun install` — install dependencies for all packages
- `bun run --filter @ouroboros/cli test` — run CLI tests
- `bun run --filter @ouroboros/desktop dev` — start desktop app in dev mode

## Testing Policy

Every new feature, improvement, or bug fix MUST ship with automated tests that
would catch the regression if the change were reverted. This is non-negotiable —
a change without a matching test is incomplete.

- **CLI changes (`packages/cli/`)** — add a unit test and/or integration test:
  - Unit tests live alongside the area under test in `packages/cli/tests/`
    (e.g. `tests/tools/`, `tests/llm/`, `tests/memory/`).
  - Integration tests that exercise multiple subsystems live in
    `packages/cli/tests/integration/`.
  - Use Bun's test runner (`bun test`).
- **Desktop changes (`packages/desktop/`)** — add a new E2E test:
  - E2E tests live in `packages/desktop/tests/e2e/` and run via Playwright.
  - Cover the user-visible behavior that the change introduces or fixes.
  - Pure logic outside the renderer may also warrant a unit test in
    `packages/desktop/tests/` (e.g. `conversation-store.test.ts`).
- **Shared changes (`packages/shared/`)** — add tests to whichever package
  consumes the change; at minimum, cover behavior from the CLI side.
- **Bug fixes** — the new test MUST fail against the un-fixed code and pass
  after the fix. Write the failing test first.

### Per-surface test checklist

When adding or changing code, pick the row(s) that apply and ensure the
listed test is new or updated:

| Surface you changed                        | Test that MUST exist or be updated                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| A CLI tool (`packages/cli/src/tools/`)     | Unit test in `packages/cli/tests/tools/`                                          |
| Agent loop, LLM, memory, RSI               | Test in the matching subfolder of `packages/cli/tests/`                           |
| New or renamed RPC method in `protocol.ts` | Update `RPC_METHOD_NAMES` in protocol.ts; `protocol-contract.test.ts` must pass   |
| New notification type in `protocol.ts`     | Update `NOTIFICATION_METHOD_NAMES`; `protocol-contract.test.ts` must pass         |
| JSON-RPC transport / server / dispatcher   | Extend `packages/cli/tests/integration/json-rpc-transport.test.ts`                |
| Desktop main process / IPC handler         | E2E scenario in `main-process.spec.ts` or `real-flows.spec.ts`                    |
| Desktop renderer UI                        | E2E scenario in `renderer-contract.spec.ts` or a new spec                         |
| Zustand store logic                        | Unit test in `packages/desktop/tests/`                                            |
| Bug fix                                    | A test that FAILS without the fix and PASSES with it                              |

## Workflow

- After implementing a feature or fixing a bug, run the full verification
  suite from the repo root before reporting completion:

  ```
  bun run verify
  ```

  which runs lint, typecheck (CLI and desktop), CLI tests, and desktop E2E.
  To run the live-LLM suite (manual, not in CI or pre-push):

  ```
  bun run test:cli:live
  ```
- A `pre-push` git hook (installed via `husky`) runs lint + typecheck + CLI
  tests on every `git push`. This catches regressions before CI sees them.
  Run `bun install` once to activate the hook.
- If any step fails, fix the issue and re-run.
- Do not claim work is complete until `bun run verify` passes AND the
  appropriate test from the checklist above is in place.
