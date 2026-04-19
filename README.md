# Ouroboros

An embeddable agent harness and CLI with a recursive self-improvement layer for building agentic AI systems.
TypeScript on [Bun](https://bun.sh).

Ouroboros provides a provider-agnostic ReAct loop, a plugin-based tool registry, multi-layer memory, and portable [Agent Skills](https://agentskills.io) — everything you need to build, compose, and run AI agents. The core is designed to be embedded in CLIs, web servers, or other applications with no coupling to a specific LLM provider or UI.

Built on this harness, Ouroboros ships with a recursive self-improvement layer: it can reflect on completed tasks, generating new ideas, extract reusable skills, validate them through automated testing, and consolidate memory between sessions — all autonomously without human involement.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- One LLM provider configured:
  - `ANTHROPIC_API_KEY` for Claude (default)
  - `OPENAI_API_KEY` for OpenAI models
  - or a ChatGPT Plus/Pro subscription login for `openai-chatgpt`

```bash
bun install   # install dependencies for all packages
```

### CLI

```bash
# Development mode (watch + auto-reload)
cd packages/cli
bun run dev

# — or from the repo root —
bun run dev
```

Build and run the compiled binary:

```bash
cd packages/cli
bun run build

./dist/ouroboros              # Interactive REPL
./dist/ouroboros -m "Hello"   # Single-shot
echo "Explain this" | ./dist/ouroboros   # Pipe input
```

### Desktop App (Electron)

```bash
cd packages/desktop
bun run dev          # launch in dev mode with hot-reload
```

Build distributable packages:

```bash
cd packages/desktop
bun run build        # compile + package (unpacked, current platform)
bun run build:mac    # macOS .dmg / .zip
bun run build:win    # Windows installer
```

## CLI Flags

| Flag                       | Description                                |
| -------------------------- | ------------------------------------------ |
| `-m <prompt>`              | Single-shot mode — run one prompt and exit |
| `--model <provider/model>` | Override model (e.g. `openai/gpt-4o`)      |
| `--verbose`, `-v`          | Show tool call details                     |
| `--no-stream`              | Wait for full response before printing     |
| `--config <path>`          | Path to `.ouroboros` config file           |
| `--max-steps <steps>`      | Override autonomous step limit             |

## Configuration

Ouroboros is configured via a `.ouroboros` JSON file in the project root. All fields are optional and have sensible defaults.

### AGENTS.md support

Ouroboros also supports the [AGENTS.md](https://agents.md/) instruction format.

- `.ouroboros`: machine-readable runtime configuration such as model, permissions, and RSI settings.
- `AGENTS.md`: human-authored agent instructions that are injected into the system prompt.
- `MEMORY.md` / `memory/`: accumulated runtime memory, separate from repo instructions.

Discovery is workspace-aware:

- In a single repo, Ouroboros loads `AGENTS.md` from the current working directory or its ancestors.
- In nested workspaces or package folders, it loads all matching `AGENTS.md` files from root to nearest folder.
- More specific workspace/package instructions appear after broader root instructions.
- If no `AGENTS.md` is present, prompt construction proceeds normally with no extra section.

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-5.4"
  },
  "permissions": {
    "tier0": true,
    "tier1": true,
    "tier2": true,
    "tier3": false,
    "tier4": false
  },
  "skillDirectories": ["skills/core", "skills/generated"],
  "agent": {
    "maxSteps": {
      "interactive": 200,
      "desktop": 200,
      "singleShot": 50,
      "automation": 100
    }
  },
  "memory": {
    "consolidationSchedule": "session-end"
  }
}
```

Config values can also be set via environment variables (e.g. `OUROBOROS_MODEL_PROVIDER=openai`).

### Provider Setup

#### Anthropic / OpenAI API key providers

Use a normal `.ouroboros` config plus the matching API key:

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-5.4",
    "apiKey": "YOUR OPENAI API KEY"
  }
}
```

#### OpenAI ChatGPT subscription provider

`openai-chatgpt` uses OAuth login, not an API key. Credentials are stored separately from project config in `~/.ouroboros/auth.json`.

1. Set the provider in `.ouroboros`:

```json
{
  "model": {
    "provider": "openai-chatgpt",
    "name": "gpt-5.4"
  }
}
```

2. Log in from the CLI:

```bash
cd packages/cli
bun run dev -- auth login --provider openai-chatgpt
```

Or with the compiled binary:

```bash
./dist/ouroboros auth login --provider openai-chatgpt
```

Available login methods:

```bash
./dist/ouroboros auth login --provider openai-chatgpt --method browser
./dist/ouroboros auth login --provider openai-chatgpt --method headless
```

Useful auth commands:

```bash
./dist/ouroboros auth list
./dist/ouroboros auth logout --provider openai-chatgpt
```

Desktop setup uses the same auth store. In the onboarding flow or Settings page, choose `ChatGPT Subscription` and complete the browser sign-in flow. No API key field is required for that provider.

## Architecture

### The Harness

Ouroboros is structured as a set of composable layers, each independently useful:

```
            ┌──────────────────────────────────────┐
            │        Your Application              │
            │   CLI · Web · JSON-RPC · Slack bot   │
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
            │   RSI Layer (optional, Phase 2)      │
            │   crystallize · self-test · dream    │
            └──────────────────────────────────────┘
```

![Full diagram](./docs/architecture.svg).

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
- **OpenAI ChatGPT subscription** via `openai-chatgpt`
- **OpenAI-compatible** endpoints (Ollama, vLLM, etc.) via `baseUrl` config

### Embedding the Harness

The agent is decoupled from the CLI. To embed it in your own application:

```typescript
import { Agent } from './src/agent'
import { createProvider } from './src/llm/provider'
import { createRegistry } from './src/tools/registry'

const model = createProvider({ provider: 'openai', name: 'gpt-5.4' })
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
ouroboros/
├── packages/
│   ├── cli/            # @ouroboros/cli — CLI agent (main package)
│   ├── desktop/        # @ouroboros/desktop — Electron desktop app
│   └── shared/         # @ouroboros/shared — Shared types & utilities
├── skills/             # Agent Skills (core, staging, generated)
├── memory/             # Persistent memory files
├── docs/
└── tickets/
```

## Scripts

All commands can be run from the repo root or from the relevant package directory.

**From the repo root:**

```bash
bun run dev           # Start CLI in watch mode
bun run build         # Build CLI binary
bun run test          # Run CLI unit tests
bun run test:all      # Run all CLI tests (including live LLM)
bun run lint          # Lint all packages
bun run ts-check      # Type-check all packages
```

**From `packages/cli/`:**

```bash
bun run dev           # Watch mode with auto-reload
bun run build         # Build to dist/ouroboros
bun test              # Unit tests
bun run test:all      # All tests including live LLM
bun run lint          # Prettier check
bun run ts-check      # TypeScript type check
```

**From `packages/desktop/`:**

```bash
bun run dev           # Launch Electron dev mode
bun run build         # Build + package (current platform)
bun run build:mac     # Build macOS distributable
bun run build:win     # Build Windows distributable
bun run ts-check      # TypeScript type check
```

## Development Diary

[docs/DIARY.md](docs/DIARY.md) is a narrative log of how Ouroboros came to life, written from the agent's own perspective.

## License

MIT — see [LICENSE](LICENSE) for details.
