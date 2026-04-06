# IPC Bridge & CLI Process Manager

**Phase:** 3.1 — Scaffolding
**Type:** Full-stack
**Priority:** P0
**Depends on:** 01-cli-json-rpc, 02-electron-scaffolding
**Repo:** `ouroboros-desktop`

## Context

The Electron main process needs to spawn the Ouroboros CLI as a child process, communicate with it via JSON-RPC over stdin/stdout, and relay messages to the renderer via Electron IPC. This is the critical bridge that connects the presentation layer to the agent intelligence.

## Requirements

### CLI Process Manager (`src/main/cli-process.ts`)

A module that manages the CLI child process lifecycle:

- **Spawn:** Start the CLI binary with `--json-rpc` flag. The binary path comes from `resources/` (production) or a configured dev path (development).
- **Health check:** On startup, send a `config/get` request and verify a response arrives within 5 seconds. If not, report the CLI as unhealthy.
- **Restart:** If the CLI process exits unexpectedly, attempt to restart it (max 3 retries with 1s delay). If all retries fail, show an error dialog to the user.
- **Graceful shutdown:** On app quit, send a close signal and wait up to 3 seconds for the CLI to exit before force-killing.
- **Stdin writer:** Method to send JSON-RPC requests as NDJSON lines to the CLI's stdin.
- **Stdout reader:** Line-based reader on the CLI's stdout that parses each line as a JSON-RPC message and dispatches it (response or notification).
- **Stderr capture:** Collect stderr for debug logging. Make it available via a dev tools panel or log file.

### JSON-RPC Client (`src/main/rpc-client.ts`)

A typed client that wraps the raw stdin/stdout transport:

- **Request method:** `send(method, params) -> Promise<result>` — sends a request, returns a promise that resolves when the matching response (by `id`) arrives. Times out after 30 seconds.
- **Notification listener:** `onNotification(method, callback)` — register handlers for incoming notifications (e.g., `agent/text`, `agent/toolCallStart`).
- **ID management:** Auto-incrementing integer IDs for requests.
- **Error handling:** JSON-RPC error responses reject the promise with a typed error.

### IPC Bridge (`src/main/preload.ts` + `src/main/ipc-handlers.ts`)

Extend the preload script to expose a typed API to the renderer:

```typescript
// Exposed to renderer via contextBridge
interface OuroborosAPI {
  // Request/response (renderer sends, waits for response)
  rpc(method: string, params?: unknown): Promise<unknown>

  // Subscribe to notifications (CLI -> renderer)
  onNotification(channel: string, callback: (params: unknown) => void): () => void

  // Native OS features
  showOpenDialog(options: OpenDialogOptions): Promise<string | null>
  getTheme(): Promise<'light' | 'dark'>
  setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>
  getPlatform(): 'darwin' | 'win32'

  // CLI status
  onCLIStatus(callback: (status: 'starting' | 'ready' | 'error' | 'restarting') => void): () => void
}
```

The main process IPC handlers translate between the renderer's `rpc()` calls and the JSON-RPC client's `send()` method. Notifications from the CLI are forwarded to the renderer via IPC `webContents.send()`.

### Shared Protocol Types (`src/shared/protocol.ts`)

Define TypeScript types for all JSON-RPC messages from the PRD (Section 5.2):

- Request param types and response types for all 19 methods
- Notification param types for all 10 notification methods
- `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification` base types
- These types are shared between main and renderer for type safety

## Scope Boundaries

- This ticket wires up the communication layer only — no UI changes beyond a connection status indicator
- The renderer can call `rpc()` and receive notifications, but no views consume them yet (that's tickets 04+)
- CLI binary bundling for production builds is deferred to ticket 13 — in dev mode, use a configured path to the CLI repo's dev binary

## Acceptance Criteria

- [ ] CLI child process spawns on app launch and responds to a health check
- [ ] `rpc(method, params)` sends a JSON-RPC request and returns the response
- [ ] Notifications from the CLI are forwarded to the renderer via IPC
- [ ] CLI process restarts automatically if it exits unexpectedly (up to 3 retries)
- [ ] Graceful shutdown sends close signal and waits before force-killing
- [ ] Request timeout (30s) rejects the promise with a clear error
- [ ] Invalid JSON-RPC responses are handled gracefully (logged, not crashed)
- [ ] CLI status changes ('starting', 'ready', 'error', 'restarting') are emitted to the renderer
- [ ] All protocol message types are defined in `src/shared/protocol.ts`
- [ ] Preload API is typed and uses contextBridge (no Node.js access in renderer)

## Feature Tests

- **Test: CLI spawns and health check passes**
  - **Setup:** App launches with a valid CLI binary path.
  - **Action:** Observe CLI process manager logs.
  - **Expected:** CLI process spawns, `config/get` health check succeeds, status transitions to 'ready'.

- **Test: RPC round-trip**
  - **Setup:** CLI is running. Renderer calls `rpc('config/get', {})`.
  - **Action:** Wait for promise resolution.
  - **Expected:** Returns a valid OuroborosConfig object.

- **Test: Notification forwarding**
  - **Setup:** Renderer subscribes to `agent/text` notifications. Trigger `agent/run` via RPC.
  - **Action:** Observe notification callbacks.
  - **Expected:** Renderer receives `agent/text` events with text chunks.

- **Test: CLI crash recovery**
  - **Setup:** CLI is running and healthy.
  - **Action:** Kill the CLI process externally.
  - **Expected:** Status changes to 'restarting'. CLI respawns. After health check, status returns to 'ready'.

- **Test: Request timeout**
  - **Setup:** Mock CLI that never responds.
  - **Action:** Call `rpc('config/get', {})`.
  - **Expected:** Promise rejects after 30 seconds with a timeout error.

- **Test: Graceful shutdown**
  - **Setup:** CLI is running. User quits the app.
  - **Action:** Observe process lifecycle.
  - **Expected:** CLI process exits cleanly within 3 seconds. No orphaned processes.

## Notes

- For development, add an env var or config option `OUROBOROS_CLI_PATH` that points to the CLI binary (e.g., `../ouroboros/dist/ouroboros` or wherever `bun build --compile` outputs it). In production, this defaults to `resources/ouroboros` inside the app bundle.
- The stdout reader must handle the case where a single `data` event contains multiple NDJSON lines, or a line is split across multiple `data` events. Buffer by `\n`.
- Use Electron's `utilityProcess` or Node.js `child_process.spawn` — the latter is simpler and more predictable for stdio communication.
- The preload `onNotification` should return an unsubscribe function so React components can clean up in `useEffect` teardown.
