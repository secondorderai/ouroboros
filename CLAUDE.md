# OUROBOROS — Development Instructions

## Project Overview

Ouroboros is a recursive self-improving AI agent. TypeScript CLI on Bun.
It uses the Agent Skills standard (agentskills.io) for portable skill format.

## Tech Stack

- Runtime: Bun (TypeScript)
- LLM: Vercel AI SDK (ai package) — provider-agnostic
- DB: SQLite via bun:sqlite for transcripts
- CLI: Commander.js + Ink for rich terminal UI
- Testing: Bun test runner
- Skills: agentskills.io format (SKILL.md with YAML frontmatter)

## Architecture

- Core loop: ReAct pattern (plan → act → observe → loop)
- Tools: Registry pattern, auto-discovered from src/tools/
- Memory: 3+1 layers (MEMORY.md index, topic files, SQLite transcripts, evolution
  log)
- RSI: 4 feedback loops (crystallize, self-test, dream, evolve)
- Safety: 5-tier permission model

## Conventions

- All tools export: name, description, schema (JSON Schema), execute (async fn)
- Skills conform to agentskills.io spec — validate with skills-ref library
- Every self-modification is git-committed with structured message
- Use Zod for runtime type validation
- Prefer composition over inheritance
- Error handling: all tools return Result<T, Error> — never throw

## Commands

- bun run dev — start in development mode
- bun test — run all tests
- bun run build — build for distribution
- bun run lint — run linter
