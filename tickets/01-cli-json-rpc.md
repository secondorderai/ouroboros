# CLI JSON-RPC Mode

**Phase:** 3.1 — Scaffolding
**Type:** Backend
**Priority:** P0
**Depends on:** None
**Repo:** `ouroboros` (this repo)

## Context

The Electron desktop app communicates with the CLI via JSON-RPC 2.0 over stdin/stdout. The CLI currently only supports an interactive REPL mode with human-readable terminal output. It needs a new `--json-rpc` flag that switches to machine-readable JSON-RPC messaging, keeping the process alive across multiple conversations.

This is the only CLI-side change needed for the entire desktop app. All other tickets target the new `ouroboros-desktop` repo.

## Requirements

### `--json-rpc` flag

Add a `--json-rpc` flag to the CLI entry point (`src/cli.ts`) that:

- Disables the interactive REPL, readline, and terminal rendering (no ANSI colors, no spinners, no Ink)
- Reads newline-delimited JSON-RPC requests from stdin
- Writes newline-delimited JSON-RPC responses and notifications to stdout
- Uses stderr for debug logging only (not part of the protocol)
- Keeps the process alive indefinitely (long-running server mode)

### JSON-RPC Request Handler

Implement a request dispatcher that maps JSON-RPC method names to existing CLI/agent functionality:

| Method | Handler | Description |
|--------|---------|-------------|
| `agent/run` | Calls `agent.run()`, streams events as notifications | Start an agent turn |
| `agent/cancel` | Cancels the in-progress agent run | Stop execution |
| `session/list` | Queries TranscriptStore | List sessions |
| `session/load` | Queries TranscriptStore by ID | Load a session |
| `session/new` | Creates new session context | New conversation |
| `session/delete` | Deletes from TranscriptStore | Remove a session |
| `config/get` | Returns current OuroborosConfig | Read config |
| `config/set` | Updates config field and persists | Write config |
| `config/testConnection` | Creates a provider and pings the API | Validate API key |
| `skills/list` | Queries SkillManager | List skills |
| `skills/get` | Reads full SKILL.md content | Skill details |
| `rsi/dream` | Calls RSIOrchestrator.triggerDream() | Manual dream |
| `rsi/status` | Returns orchestrator state | RSI pipeline status |
| `evolution/list` | Calls getEntries() | Query evolution log |
| `evolution/stats` | Calls getStats() | Evolution summary |
| `approval/list` | Returns pending approval queue | List approvals |
| `approval/respond` | Resolves a pending approval | Approve/deny |
| `workspace/set` | Changes process.cwd() or workspace config | Switch directory |

### Event-to-Notification Bridge

When `agent.run()` is active, the existing `AgentEvent` callbacks must be translated to JSON-RPC notifications:

| AgentEvent | JSON-RPC Notification |
|------------|----------------------|
| `{ type: 'text', text }` | `{ method: 'agent/text', params: { text } }` |
| `{ type: 'tool-call-start', ... }` | `{ method: 'agent/toolCallStart', params: { toolCallId, toolName, input } }` |
| `{ type: 'tool-call-end', ... }` | `{ method: 'agent/toolCallEnd', params: { toolCallId, toolName, result, isError } }` |
| `{ type: 'turn-complete', ... }` | `{ method: 'agent/turnComplete', params: { text, iterations } }` |
| `{ type: 'error', ... }` | `{ method: 'agent/error', params: { message, recoverable } }` |
| `{ type: 'rsi-reflection', ... }` | `{ method: 'rsi/reflection', params: { reflection } }` |
| `{ type: 'rsi-crystallization', ... }` | `{ method: 'rsi/crystallization', params: { result } }` |
| `{ type: 'rsi-dream', ... }` | `{ method: 'rsi/dream', params: { result } }` |
| `{ type: 'rsi-error', ... }` | `{ method: 'rsi/error', params: { stage, message } }` |

### Transport

- One JSON object per line (NDJSON) on both stdin and stdout
- Requests have `id`, `method`, `params` per JSON-RPC 2.0
- Responses have `id`, `result` (or `error`) per JSON-RPC 2.0
- Notifications have `method`, `params` but no `id`
- UTF-8 encoding

### Error Handling

- Unknown methods return JSON-RPC error code `-32601` (Method not found)
- Invalid JSON returns error code `-32700` (Parse error)
- Invalid params return error code `-32602` (Invalid params)
- Internal errors return error code `-32603` with the error message
- Errors never crash the process — the JSON-RPC server stays alive

## Scope Boundaries

- This ticket implements the JSON-RPC server mode only — it does NOT modify the existing REPL mode
- The `--json-rpc` flag and normal interactive mode are mutually exclusive
- This ticket does NOT implement the approval queue system (Tier 3/4 approvals) — `approval/list` and `approval/respond` can return empty/not-implemented initially
- This ticket does NOT implement `config/testConnection` beyond basic structure — the actual API ping logic can be refined later

## Acceptance Criteria

- [ ] `ouroboros --json-rpc` starts the CLI in JSON-RPC server mode
- [ ] Stdin JSON-RPC requests are parsed and dispatched to the correct handler
- [ ] `agent/run` streams agent events as JSON-RPC notifications on stdout
- [ ] `agent/cancel` stops an in-progress agent run
- [ ] `session/list`, `session/load`, `session/new`, `session/delete` work correctly
- [ ] `config/get` and `config/set` read/write the `.ouroboros` config
- [ ] `skills/list` returns the skill catalog
- [ ] `evolution/list` and `evolution/stats` query the evolution log
- [ ] All errors return proper JSON-RPC error responses (never crash)
- [ ] The process stays alive after errors and between requests
- [ ] Existing REPL mode is unaffected when `--json-rpc` is not passed

## Feature Tests

- **Test: Basic request/response round-trip**
  - **Setup:** Start CLI with `--json-rpc`. Send `session/new` request via stdin.
  - **Action:** Read stdout.
  - **Expected:** JSON-RPC response with a session ID.

- **Test: Agent run streams notifications**
  - **Setup:** Start CLI with `--json-rpc` and mock LLM. Send `agent/run` with a message.
  - **Action:** Collect all stdout lines until `agent/turnComplete`.
  - **Expected:** At least one `agent/text` notification followed by `agent/turnComplete`.

- **Test: Tool call events are bridged**
  - **Setup:** Mock LLM that triggers a tool call. Send `agent/run`.
  - **Action:** Collect notifications.
  - **Expected:** `agent/toolCallStart` followed by `agent/toolCallEnd` with matching `toolCallId`.

- **Test: Unknown method returns error**
  - **Setup:** Send `{ "jsonrpc": "2.0", "id": 1, "method": "nonexistent/method", "params": {} }`.
  - **Expected:** JSON-RPC error response with code `-32601`.

- **Test: Invalid JSON returns parse error**
  - **Setup:** Send `not valid json\n` on stdin.
  - **Expected:** JSON-RPC error response with code `-32700`. Process stays alive.

- **Test: Process stays alive after errors**
  - **Setup:** Send invalid JSON, then a valid `config/get` request.
  - **Expected:** First gets parse error, second gets valid config response.

- **Test: Config get/set round-trip**
  - **Setup:** Send `config/set` with `{ path: "model.name", value: "test-model" }`, then `config/get`.
  - **Expected:** Returned config has `model.name` equal to `"test-model"`.

## Notes

- Implement the JSON-RPC server as a separate module (`src/json-rpc/server.ts` or similar) so it's cleanly separated from the REPL code.
- Use a line-based reader on stdin (e.g., readline or manual `\n` splitting on the data event).
- The `agent/run` handler needs to create the Agent with an `onEvent` callback that writes notifications. The agent itself is unchanged — we're just wiring events to stdout instead of the terminal renderer.
- Look at how `src/cli.ts` currently initializes the agent — the JSON-RPC mode will do the same setup but skip the REPL and renderer.
