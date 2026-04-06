# OUROBOROS — Development Instructions

## Project Overview

Ouroboros is a recursive self-improving AI agent. TypeScript on Bun, structured as
a monorepo with Bun workspaces. It uses the Agent Skills standard (agentskills.io)
for portable skill format.

## Monorepo Structure

```
ouroboros/
├── packages/
│   ├── cli/              # @ouroboros/cli — CLI agent (main package)
│   │   ├── src/
│   │   ├── tests/
│   │   └── package.json
│   ├── desktop/          # @ouroboros/desktop — Electron desktop app
│   │   ├── src/
│   │   └── package.json
│   └── shared/           # @ouroboros/shared — Shared types & utilities
│       ├── src/
│       └── package.json
├── package.json          # Root: Bun workspaces config
├── tsconfig.base.json    # Shared TypeScript settings (packages extend this)
├── skills/               # Runtime data — agent skills (stays at root)
├── memory/               # Runtime data — agent memory (stays at root)
├── docs/
└── tickets/
```

## Tech Stack

- Runtime: Bun (TypeScript)
- LLM: Vercel AI SDK (ai package) — provider-agnostic
- DB: SQLite via bun:sqlite for transcripts
- CLI: Commander.js + Ink for rich terminal UI
- Desktop: Electron + React + Vite
- Testing: Bun test runner
- Skills: agentskills.io format (SKILL.md with YAML frontmatter)

## Architecture

- Core loop: ReAct pattern (plan → act → observe → loop)
- Tools: Registry pattern, auto-discovered from packages/cli/src/tools/
- Memory: 3+1 layers (MEMORY.md index, topic files, SQLite transcripts, evolution
  log)
- RSI: 4 feedback loops (crystallize, self-test, dream, evolve)
- Safety: 5-tier permission model
- Shared types: imported as `@ouroboros/shared` across packages

## Conventions

- All tools export: name, description, schema (JSON Schema), execute (async fn)
- Skills conform to agentskills.io spec — validate with skills-ref library
- Every self-modification is git-committed with structured message
- Use Zod for runtime type validation
- Prefer composition over inheritance
- Error handling: all tools return Result<T, Error> — never throw
- Each package has its own tsconfig.json extending root tsconfig.base.json

## Commands

Run from `packages/cli/` (or use `--filter` from root):

- `bun run dev` — start CLI in development mode
- `bun test` — run all CLI tests
- `bun run build` — build CLI for distribution
- `bun run lint` — run linter
- `bun run ts-check` — TypeScript type check
- `bun run test:all` — all tests including live LLM tests

From the repository root (using workspace filters):

- `bun run --filter @ouroboros/cli test` — run CLI tests
- `bun run --filter @ouroboros/desktop dev` — start desktop app in dev mode
- `bun install` — install dependencies for all packages

## Workflow

- After implementing a feature or fixing a bug, ALWAYS run the full verification
  suite before reporting completion (from `packages/cli/`):
  1. `bun run lint` — format check
  2. `bun run ts-check` — type check
  3. `bun run test:all` — all tests including live LLM tests
- If any step fails, fix the issue and re-run from step 1.
- Do not claim work is complete until all checks pass.
