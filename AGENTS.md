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
- Tier-0/1 `bash` and `code-exec` children run under an OS sandbox by default
  (Seatbelt on macOS, bubblewrap on Linux via `@anthropic-ai/sandbox-runtime`).
  The facade and policy live in `packages/cli/src/safety/`; `denyWrite` on
  `skills/`, `memory/`, and `.ouroboros` kernel-enforces the tier-3
  self-modification gate. Sandbox violations immediately request tier-4 human
  approval for an unsandboxed re-run (`sandbox.escalateOnViolation`, default
  true); the model can also escalate explicitly via `bypassSandbox: true`,
  which resolves to tier 4.
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
- Keep the OS sandbox enabled by default and never remove `skills/`,
  `memory/`, or `.ouroboros` from the built-in `denyWrite` policy; sandbox
  wrapping happens inside tool `execute()` after registry tier enforcement so
  it adds no new approval prompts.
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

Every new feature or behavioral enhancement must ship with **both** unit tests
for its logic and integration regression tests for the affected public path
(for example, agent/tool wiring, JSON-RPC, CLI subprocess, or Electron UI). The
integration test must exercise real components across that boundary; mock only
external services or nondeterministic dependencies. Both layers must run in
`bun run verify`, except for the benchmark-only verification path below. A
change without either layer is incomplete.

Bug fixes need a regression test that fails before the fix and passes after it;
add both layers when the bug spans component boundaries. Before implementation,
identify the unit and integration tests to add. Read and update the relevant
coverage row in [docs/test-plan.md](docs/test-plan.md) for test locations,
protocol obligations, and examples. Keep detailed test guidance there rather
than expanding this root file.

## Verification

After implementation, run `bun run verify` from the repo root before reporting
completion. It runs lint, type checks, CLI tests, and desktop E2E. If any step
fails, fix the issue and rerun. Live LLM tests are manual only:
`bun run test:cli:live`.

For changes confined to `benchmarks/`, skip the desktop E2E suite. Run the
benchmark's own applicable tests, then run `bun run lint`, `bun run ts-check`,
and `bun run test:cli` from the repo root instead of `bun run verify`. This
exception does not apply when the change also touches `packages/desktop` or a
shared contract used by the desktop app.
