# Dist CLI Subprocess Tests — Design Spec

> **Current status:** Historical design spec. Compiled CLI subprocess coverage is
> now represented in `packages/cli/tests/dist-cli.test.ts` and summarized in
> `docs/test-plan.md`.

**Date:** 2026-04-06
**Status:** Approved

## Problem

The compiled binary `./dist/ouroboros` had two CLI parsing bugs that shipped undetected:

1. Commander.js v14 auto-shows help and exits when the root command has subcommands (`dream`) but no `.action()` handler. This blocked both no-args REPL mode and the `-m` flag.
2. The initial fix incorrectly assumed compiled Bun binaries use a 1-prefix `process.argv` format, but they actually use `["bun", "/$bunfs/root/<name>", ...args]` (standard Node 2-prefix format).

Neither bug was caught because all existing CLI tests import TypeScript source and mock internals. The compiled binary is never spawned as a subprocess in any test.

## Solution

Add subprocess smoke tests that build the binary and spawn it for each flag combination. The core invariant: **stdout/stderr must NOT contain `"Usage:"` unless `--help` was explicitly passed**. This is the exact signal that distinguishes "Commander.js took over" from "application code is running."

Tests that exercise flags requiring an LLM (`-m`, piped stdin) do not need the agent to succeed — they just confirm the binary gets past Commander.js into application logic. Config or provider errors are acceptable; help text is not.

## Test File

`tests/dist-cli.test.ts`

## Setup

- `beforeAll`: runs `bun build --compile --minify ./src/cli.ts --outfile dist/ouroboros` so tests always run against current source.
- Helper `spawnBinary(...args)`: wraps `Bun.spawn` to run `./dist/ouroboros` with given args, captures stdout/stderr, enforces a 10s timeout.

## Test Cases

| # | Test name | Spawn args | Assertions |
|---|-----------|-----------|------------|
| 1 | `--help shows usage` | `['--help']` | stdout contains `"Usage:"`, exit 0 |
| 2 | `--version shows version` | `['--version']` | stdout contains `"0.1.0"`, exit 0 |
| 3 | `--debug-tools lists tools` | `['--debug-tools']` | stdout contains `"tools registered"`, no `"Usage:"`, exit 0 |
| 4 | `dream --help shows subcommand help` | `['dream', '--help']` | stdout contains `"dream"` and `"consolidate"`, exit 0 |
| 5 | `-m flag accepted` | `['-m', 'hello']` | no `"Usage:"` in output (may error on missing API key) |
| 6 | `--message flag accepted` | `['--message', 'hello']` | no `"Usage:"` in output |
| 7 | `piped stdin accepted` | `[]` with `"hello"` piped to stdin | no `"Usage:"` in output |
| 8 | `no args, no stdin (REPL path)` | `[]` with stdin left open, kill after 2s | no `"Usage:"` in output, process was still alive (didn't auto-exit with help) |
| 9 | `--model flag accepted` | `['--model', 'anthropic/claude-sonnet-4-20250514', '--debug-tools']` | stdout contains `"tools registered"`, no `"Usage:"`, exit 0 |
| 10 | `combined flags accepted` | `['-v', '--no-stream', '--no-rsi', '--debug-tools']` | stdout contains `"tools registered"`, no `"Usage:"`, exit 0 |

## Package.json Script

```json
"test:dist": "bun test tests/dist-cli.test.ts --timeout 60000"
```

## What This Does NOT Cover

- Full end-to-end agent flow (requires API keys — covered by `test:live`)
- Interactive REPL behavior (requires PTY — out of scope)
- JSON-RPC server mode (separate concern)
