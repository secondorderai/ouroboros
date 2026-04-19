# Ouroboros Automated Test Plan

This matrix is the maintained source of truth for regression coverage across the
CLI agent, JSON-RPC bridge, and Electron desktop app. New product behavior should
add or update the matching row and ship with an automated test.

## Verification Gates

| Gate | Command | Purpose |
| --- | --- | --- |
| CLI unit and integration | `bun run test:cli` | Deterministic mock-LLM coverage for CLI, tools, memory, RSI, and JSON-RPC. |
| Desktop E2E | `bun run test:desktop` | Playwright coverage for renderer, main process, and mock CLI transport flows. |
| Types | `bun run ts-check` | TypeScript contract coverage for all packages. |
| Formatting | `bun run lint` | Prettier check for CLI source and tests; desktop currently has no linter. |
| Full release gate | `bun run verify` | Required pre-completion gate: lint, typecheck, CLI tests, desktop E2E. |
| Binary smoke | `cd packages/cli && bun run test:dist` | Optional compiled CLI regression tests. |
| Live provider smoke | `bun run test:cli:live` | Optional manual LLM/provider smoke; not a CI gate. |

## CLI Coverage Matrix

| Feature surface | Primary tests | Required scenarios |
| --- | --- | --- |
| CLI command surface | `packages/cli/tests/cli.test.ts`, `packages/cli/tests/dist-cli.test.ts`, `packages/cli/tests/root-dev.test.ts` | Help/version/debug tools, single-shot `-m` and piped stdin, REPL startup, model/config/max-step flags, streaming and verbose output, auth subcommands, dream subcommand. |
| Agent loop | `packages/cli/tests/agent.test.ts`, `packages/cli/tests/integration/agent-tools.test.ts` | Streaming text, tool calls, parallel tool calls, tool errors, unknown tools, thrown exceptions, max-step handoff, retryable and non-retryable provider failures, event-handler resilience, multi-turn state. |
| LLM providers | `packages/cli/tests/llm/provider.test.ts`, `packages/cli/tests/llm/streaming.test.ts` | Anthropic, OpenAI, OpenAI-compatible, ChatGPT subscription auth, malformed tool-call deltas, provider error classification, image message conversion. |
| Prompt assembly | `packages/cli/tests/llm/prompt.test.ts`, `packages/cli/tests/integration/prompt-assembly.test.ts`, `packages/cli/tests/agents-md.test.ts` | Tool schema injection, skill catalog, layered memory, AGENTS.md stacking, desktop-readable hints, empty section omission. |
| Tool registry | `packages/cli/tests/tools/registry.test.ts` | Built-in discovery, JSON Schema conversion, invalid args, unknown tools, thrown tool errors, bundled-regression static registry. |
| Core tools | `packages/cli/tests/tools/*.test.ts` | Schema validation, happy path, and failure path for every built-in tool, including RSI wrappers: `crystallize`, `dream`, `evolution`, `self-test`, `skill-gen`. |
| Config and auth | `packages/cli/tests/config.test.ts`, `packages/cli/tests/auth/openai-chatgpt.test.ts` | Defaults, `.ouroboros`, env precedence, invalid config, API key precedence, ChatGPT OAuth store, refresh, logout, no secret leakage. |
| Memory | `packages/cli/tests/memory/*.test.ts`, `packages/cli/tests/integration/agent-memory.test.ts` | MEMORY.md, topics, transcripts, observations, checkpoints, durable/checkpoint/working memory loaders, compaction lifecycle, transcript search. |
| RSI | `packages/cli/tests/rsi/*.test.ts`, `packages/cli/tests/memory/dream.test.ts` | Reflection, crystallization proposals, skill generation, skill validation, dream consolidation, evolution log stats, auto-reflect on/off, manual dream, failure isolation. |
| Modes | `packages/cli/tests/modes/*.test.ts` | Plan mode definition, tool filtering, bash interception, enter/submit/exit mode lifecycle. |
| JSON-RPC | `packages/cli/tests/json-rpc.test.ts`, `packages/cli/tests/integration/json-rpc-transport.test.ts`, `packages/cli/tests/integration/protocol-contract.test.ts` | Every method handler, invalid params, notification bridge, malformed NDJSON, concurrent request IDs, cancellation, sessions, images, workspace switching, modes, approvals, Ask User, RSI and evolution methods. |

## Desktop Coverage Matrix

| Feature surface | Primary tests | Required scenarios |
| --- | --- | --- |
| Renderer contracts | `packages/desktop/tests/e2e/renderer-contract.spec.ts` | Onboarding, preload APIs, notification-driven state, chat rendering, attachments, approvals, Ask User, settings, mode sync, update banner. |
| Production-path flows | `packages/desktop/tests/e2e/real-flows.spec.ts` | Mock CLI JSON-RPC transport, onboarding through chat, streaming, cancellation, sessions, command palette, approvals queue, RSI drawer, external links. |
| Main process | `packages/desktop/tests/e2e/main-process.spec.ts`, `packages/desktop/tests/rpc-client.test.ts` | CLI launch, ready/restarting/error status, crash recovery limit, JSON-RPC round trip, menu accelerator, stale API key safety, update install hook. |
| Conversation store | `packages/desktop/tests/conversation-store.test.ts` | Session title derivation, run state, streaming reconciliation, tool-call persistence, cancellation state. |
| Onboarding | `renderer-contract.spec.ts`, `real-flows.spec.ts` | Provider choices, API key/base URL/model capture, ChatGPT login flow, workspace picker, template selection, first session creation, failure persistence. |
| Chat composer | `renderer-contract.spec.ts`, `real-flows.spec.ts` | Empty send disabled, multiline input, stop, retry, desktop-readable payload, native attach dialog, drag/drop, image previews and rejection, workspace selection, mode chip. |
| Sessions and sidebar | `renderer-contract.spec.ts`, `real-flows.spec.ts` | List/load/new/delete, running indicators, sidebar toggle, persisted open state, resize clamping, active session selection. |
| Command palette | `real-flows.spec.ts` | Keyboard open/close, fuzzy search, keyboard navigation, new session, settings, RSI, approvals, workspace, dream action, empty state. |
| Settings | `renderer-contract.spec.ts`, `real-flows.spec.ts` | Load failures, Escape close, provider/auth/model settings, permissions confirmation, memory schedule, RSI threshold and auto-reflect, mode section sync. |
| RSI UI | `real-flows.spec.ts`, `packages/desktop/tests/rsi-history.test.ts` | Drawer stats/history/checkpoints, dream run, notification updates, crystallization dismissal, history filters, checkpoint cache, compaction continuity. |
| Rendering | `renderer-contract.spec.ts`, `mermaid-*.spec.ts`, `packages/desktop/tests/mermaid-theme.test.ts` | Markdown, code copy, external links, Mermaid theme/lightbox/zoom, jump-to-bottom, streaming cursor, responsive layout. |

## Maintenance Rules

- Prefer deterministic mocks and fixtures in CI. Live LLM tests remain manual and isolated.
- Add regression tests before or with every bug fix.
- Keep test-only fixture controls inside `tests/fixtures` or test preload hooks; do not add product APIs solely for testing.
- Use role/text/state assertions first. Reserve screenshots for visual rendering regressions where DOM assertions cannot catch the issue.
- When adding or renaming an RPC method or notification, update `packages/desktop/src/shared/protocol.ts` runtime name lists and keep `protocol-contract.test.ts` passing.
