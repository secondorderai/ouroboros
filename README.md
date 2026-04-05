# Ouroboros

A standard agent harness for building LLM-powered tools. TypeScript on [Bun](https://bun.sh).

Ouroboros provides a provider-agnostic ReAct loop, a plugin-based tool registry, multi-layer memory, and portable [Agent Skills](https://agentskills.io) — everything you need to build, compose, and run AI agents. The core is designed to be embedded in CLIs, web servers, or other applications with no coupling to a specific LLM provider or UI.

Built on this harness, Ouroboros ships with a recursive self-improvement layer: it can reflect on completed tasks, extract reusable skills, validate them through automated testing, and consolidate memory between sessions — all autonomously.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- An API key for at least one LLM provider:
  - `ANTHROPIC_API_KEY` for Claude (default)
  - `OPENAI_API_KEY` for OpenAI models

### Install and Run

```bash
bun install
bun run build

# Interactive REPL
./dist/ouroboros

# Single-shot
./dist/ouroboros -m "What files are in this directory?"

# Pipe input
echo "Explain this project" | ./dist/ouroboros
```

### Development Mode

```bash
bun run dev   # watch mode with auto-reload
```

## CLI Flags

| Flag                       | Description                                |
| -------------------------- | ------------------------------------------ |
| `-m <prompt>`              | Single-shot mode — run one prompt and exit |
| `--model <provider/model>` | Override model (e.g. `openai/gpt-4o`)      |
| `--verbose`, `-v`          | Show tool call details                     |
| `--no-stream`              | Wait for full response before printing     |
| `--config <path>`          | Path to `.ouroboros` config file           |

## Configuration

Ouroboros is configured via a `.ouroboros` JSON file in the project root. All fields are optional and have sensible defaults.

```json
{
  "model": {
    "provider": "anthropic",
    "name": "claude-sonnet-4-20250514",
    "baseUrl": "https://your-endpoint.com/v1"
  },
  "permissions": {
    "tier0": true,
    "tier1": true,
    "tier2": true,
    "tier3": false,
    "tier4": false
  },
  "skillDirectories": ["skills/core", "skills/generated"],
  "memory": {
    "sqlitePath": "memory/transcripts.db"
  }
}
```

Config values can also be set via environment variables (e.g. `OUROBOROS_MODEL_PROVIDER=openai`).

## Architecture

### The Harness

Ouroboros is structured as a set of composable layers, each independently useful:

```
            ┌──────────────────────────────────────┐
            │        Your Application               │
            │   CLI · Web · JSON-RPC · Slack bot    │
            └──────────────┬───────────────────────┘
                           │ onEvent callback
  ┌────────────────────────┼───────────────────────────────┐
  │ HARNESS                │                               │
  │            ┌───────────▼───────────┐                   │
  │            │       Agent           │                   │
  │            │   Event-driven ReAct  │◄── run(prompt)    │
  │            └───┬──────────────┬────┘                   │
  │       stream   │              │  execute               │
  │    ┌───────────▼──┐    ┌──────▼──────────┐             │
  │    │     LLM      │    │  Tool Registry  │             │
  │    │  Provider-   │    │  Plugin-based   │             │
  │    │  agnostic    │    │  Zod-validated  │             │
  │    └──────────────┘    └──┬────┬────┬────┘             │
  │                           │    │    │                  │
  │              ┌────────────┘    │    └──────────┐       │
  │        ┌─────▼─────┐  ┌───────▼──┐  ┌────────▼─────┐   │
  │        │  Memory   │  │  Skills  │  │  Your Tools  │   │
  │        │  3-layer  │  │  Agent   │  │  Drop-in     │   │
  │        │  persist  │  │  Skills  │  │  plugin      │   │
  │        └───────────┘  └──────────┘  └──────────────┘   │
  │                                                        │
  │    ┌──────────────────────────────────────────────┐    │
  │    │  Config   Zod schema + env vars + .ouroboros │    │
  │    └──────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────┘
            ┌──────────────────────────────────────┐
            │   RSI Layer (optional, Phase 2)       │
            │   crystallize · self-test · dream     │
            └──────────────────────────────────────┘
```

**Agent loop.** The `Agent` class runs a ReAct loop that streams LLM responses, detects tool calls, executes them in parallel via the tool registry, and feeds results back until the task is complete. It emits events — it never prints directly — so any consumer (CLI, web server, test harness) can drive it.

**Tool registry.** Tools are auto-discovered from `src/tools/`. Each tool exports `name`, `description`, `schema` (Zod), and `execute` (async, returns `Result<T, Error>`). The registry validates arguments against the schema before execution. Drop in a file to add a tool — no wiring needed.

**LLM abstraction.** All LLM interaction goes through an internal type layer (`LLMMessage`, `StreamChunk`, `ToolCall`) that never leaks provider SDK types. The provider factory wraps [Vercel AI SDK](https://sdk.vercel.ai) and supports Anthropic, OpenAI, and any OpenAI-compatible endpoint — swappable via config, not code.

**No throws.** Every operation returns `Result<T, Error>`. Error handling is explicit and composable throughout the entire stack.

### Built-in Tools

| Tool            | Description                             |
| --------------- | --------------------------------------- |
| `bash`          | Execute shell commands with timeout     |
| `file-read`     | Read files with optional line range     |
| `file-write`    | Create files (auto-creates directories) |
| `file-edit`     | Search-and-replace editing              |
| `web-fetch`     | Fetch URLs with HTML-to-markdown        |
| `web-search`    | Web search via DuckDuckGo               |
| `ask-user`      | Prompt the user for input               |
| `todo`          | Session task list management            |
| `memory`        | Read/write MEMORY.md and topic files    |
| `skill-manager` | Discover, activate, and manage skills   |

### Memory (3 layers)

1. **MEMORY.md** — Knowledge index, always loaded into the system prompt
2. **Topic files** (`memory/topics/*.md`) — Domain knowledge, loaded on demand
3. **SQLite transcripts** (`memory/transcripts.db`) — Full session history, keyword-searchable

### Skills

Skills follow the [Agent Skills](https://agentskills.io) open standard — portable across any agent that supports the format. They live in:

- `skills/core/` — Built-in skills shipped with Ouroboros
- `skills/staging/` — Skills under test (not yet active)
- `skills/generated/` — Self-generated skills (via the RSI layer)

Each skill is a directory with a `SKILL.md` containing YAML frontmatter (name, description) and markdown instructions. Only metadata is loaded at startup; full instructions are loaded on demand when the agent activates a skill.

### LLM Providers

Provider-agnostic via [Vercel AI SDK](https://sdk.vercel.ai). Supports:

- **Anthropic** (Claude) — default
- **OpenAI** (GPT-4o, etc.)
- **OpenAI-compatible** endpoints (Ollama, vLLM, etc.) via `baseUrl` config

### Embedding the Harness

The agent is decoupled from the CLI. To embed it in your own application:

```typescript
import { Agent } from './src/agent'
import { createProvider } from './src/llm/provider'
import { createRegistry } from './src/tools/registry'

const model = createProvider({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' })
const toolRegistry = await createRegistry()

const agent = new Agent({
  model: model.value,
  toolRegistry,
  onEvent(event) {
    // Handle text chunks, tool calls, errors, turn completion
  },
})

await agent.run('What files are in this directory?')
```

## Project Structure

```
src/
  cli.ts              # Entry point, argument parsing
  cli/                # REPL, renderer, single-shot mode
  agent.ts            # ReAct loop
  config.ts           # .ouroboros config loading (Zod)
  types.ts            # Shared types (Result<T, E>)
  llm/                # Provider factory, streaming, prompt builder
  tools/              # Tool registry + all tool implementations
  memory/             # MEMORY.md, topics, SQLite transcripts
  rsi/                # RSI engine (Phase 2)
  safety/             # Permission model (Phase 2)
skills/               # Agent Skills (core, staging, generated)
memory/               # Persistent memory files
tests/                # Unit + integration tests
```

## Scripts

```bash
bun test              # Run all tests
bun run build         # Build to dist/
bun run dev           # Watch mode
bun run lint          # Prettier check
bun run ts-check     # TypeScript type checking
```

## Contributing

All tools must follow the registry pattern — export `name`, `description`, `schema` (Zod), and `execute` (async, returns `Result<T, Error>`). Tools never throw; they return `{ ok: false, error }` on failure.

See [CLAUDE.md](CLAUDE.md) for full development conventions.

## License

See [LICENSE](LICENSE) for details.
