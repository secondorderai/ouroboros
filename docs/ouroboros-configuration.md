# .ouroboros Configuration

Ouroboros reads runtime configuration from a JSON file named `.ouroboros`.
The file controls model selection, permission tiers, Agent Skill lookup, memory
budgets, RSI behavior, artifact limits, custom agents, and MCP servers.

Use `AGENTS.md` for behavioral instructions. Use `.ouroboros` only for
machine-readable runtime settings.

## Location

For CLI runs, Ouroboros checks the directory passed to `--config`; otherwise it
checks the current working directory. If no `.ouroboros` file exists there, the
CLI can fall back to the user home directory.

For the desktop app, the Electron main process starts the CLI with the app user
data directory as the config directory. Workspace instructions still come from
`AGENTS.md` files in the selected workspace.

The `.ouroboros` file must contain one JSON object. All fields are optional and
missing values are filled from schema defaults.

## Minimal Example

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-5.5",
    "reasoningEffort": "medium"
  },
  "permissions": {
    "tier0": true,
    "tier1": true,
    "tier2": true,
    "tier3": false,
    "tier4": false
  },
  "skillDirectories": ["skills/core", "skills/generated"],
  "disabledSkills": []
}
```

## Complete Shape

```json
{
  "model": {
    "provider": "openai",
    "name": "gpt-5.5",
    "baseUrl": "https://api.openai.com/v1",
    "apiMode": "responses",
    "apiKey": "optional-fallback-key",
    "reasoningEffort": "medium"
  },
  "permissions": {
    "tier0": true,
    "tier1": true,
    "tier2": true,
    "tier3": false,
    "tier4": false
  },
  "skillDirectories": ["skills/core", "skills/generated"],
  "disabledSkills": [],
  "agent": {
    "maxSteps": {
      "interactive": 200,
      "desktop": 200,
      "singleShot": 50,
      "automation": 100
    },
    "allowedTestCommands": ["bun run test", "bun run ts-check"],
    "definitions": []
  },
  "memory": {
    "consolidationSchedule": "session-end",
    "contextWindowTokens": 400000,
    "warnRatio": 0.7,
    "flushRatio": 0.8,
    "compactRatio": 0.9,
    "tailMessageCount": 12,
    "dailyLoadDays": 2,
    "durableMemoryBudgetTokens": 1500,
    "checkpointBudgetTokens": 1200,
    "workingMemoryBudgetTokens": 1000
  },
  "rsi": {
    "noveltyThreshold": 0.7,
    "autoReflect": true,
    "observeEveryTurns": 1,
    "checkpointEveryTurns": 6,
    "durablePromotionThreshold": 0.8,
    "crystallizeFromRepeatedPatternsOnly": true
  },
  "artifacts": {
    "cdnAllowlist": [
      "https://cdn.jsdelivr.net",
      "https://unpkg.com",
      "https://cdnjs.cloudflare.com"
    ],
    "maxBytes": 1048576
  },
  "mcp": {
    "servers": []
  }
}
```

Do not commit real API keys. Prefer provider environment variables or desktop
settings for credentials.

## Model

`model.provider` supports `openai`, `anthropic`, `openai-compatible`, and
`openai-chatgpt`.

`model.name` is the provider model identifier. `model.reasoningEffort` accepts
`minimal`, `low`, `medium`, `high`, or `max`; unsupported values for a provider
are clamped or ignored by the provider adapter.

Use `model.baseUrl` and `model.apiMode` for OpenAI-compatible endpoints.
`apiMode` accepts `responses`, `chat`, or `completion`.

## Permissions

Permission tiers control what tools may do without an additional approval gate.

| Tier | Default | Purpose |
| ---- | ------- | ------- |
| `tier0` | `true` | Read-only operations |
| `tier1` | `true` | Scoped writes |
| `tier2` | `true` | Skill generation and self-test |
| `tier3` | `false` | Self-modification; requires human approval |
| `tier4` | `false` | System-level operations; requires human approval |

Agent definitions can also include `canInvokeAgents` to restrict which
subagent ids that agent may start.

## Skills

`skillDirectories` lists workspace-relative or absolute directories to scan for
Agent Skills. Each skill directory must contain a `SKILL.md` file.

`disabledSkills` lists skill names to exclude from prompt lookup, slash
invocation, and activation. Disabled skills can still appear in management UI
when requested with disabled entries included.

## Agents

`agent.maxSteps` sets step budgets for interactive CLI, desktop, single-shot,
and automation runs.

`agent.allowedTestCommands` is an exact allowlist for the restricted `test`
subagent. The test subagent may only run commands listed here.

`agent.definitions` adds or overrides agent profiles. Each definition uses:

```json
{
  "id": "audit",
  "description": "Read-only audit agent",
  "mode": "subagent",
  "prompt": "Audit the assigned files and report correctness risks.",
  "permissions": {
    "tier0": true,
    "tier1": false,
    "tier2": false,
    "tier3": false,
    "tier4": false
  },
  "maxSteps": 40
}
```

`mode` accepts `primary`, `subagent`, or `all`. Custom definitions override
built-in definitions with the same id.

## Memory And RSI

`memory.consolidationSchedule` accepts `session-end`, `daily`, or `manual`.
Memory ratios must be numbers from `0` through `1`. Token budgets and message
counts must be positive integers.

`memory.contextWindowTokens` is optional. When omitted, Ouroboros attempts to
detect the active model context window from the model registry.

`rsi` controls observation cadence, checkpoint cadence, reflection, durable
memory promotion, and whether skill crystallization requires repeated evidence.

## Artifacts

`artifacts.cdnAllowlist` lists allowed CDN origins for HTML artifact
`<script>` and `<link>` sources. `artifacts.maxBytes` caps generated HTML
artifact size in bytes.

## MCP Servers

MCP configuration lives under `mcp.servers`. Local servers use stdio:

```json
{
  "mcp": {
    "servers": [
      {
        "type": "local",
        "name": "filesystem",
        "command": "node",
        "args": ["./mcp-server.js"],
        "env": {},
        "cwd": "/path/to/project",
        "timeout": 30000,
        "requireApproval": "first-call"
      }
    ]
  }
}
```

Remote servers use streamable HTTP:

```json
{
  "mcp": {
    "servers": [
      {
        "type": "remote",
        "name": "docs",
        "url": "https://example.com/mcp",
        "headers": {},
        "timeout": 30000,
        "requireApproval": "always"
      }
    ]
  }
}
```

`requireApproval` accepts `always`, `first-call`, or `false`.

## Environment Overrides

Environment variables override `.ouroboros` values for common model and RSI
fields:

| Environment variable | Config path |
| -------------------- | ----------- |
| `OUROBOROS_MODEL_PROVIDER` | `model.provider` |
| `OUROBOROS_MODEL_NAME` | `model.name` |
| `OUROBOROS_MODEL_BASE_URL` | `model.baseUrl` |
| `OUROBOROS_MODEL_API_MODE` | `model.apiMode` |
| `ANTHROPIC_API_KEY` | `model.apiKey` when provider is `anthropic` |
| `OPENAI_API_KEY` | `model.apiKey` when provider is `openai` |
| `OUROBOROS_OPENAI_COMPATIBLE_API_KEY` | `model.apiKey` when provider is `openai-compatible` |
| `OUROBOROS_CONSOLIDATION` | `memory.consolidationSchedule` |
| `OUROBOROS_NOVELTY` | `rsi.noveltyThreshold` |
| `OUROBOROS_AUTO_REFLECT` | `rsi.autoReflect` |

## Validation

If `.ouroboros` is invalid JSON, is not a JSON object, or fails schema
validation, the CLI exits with a descriptive error. Desktop settings write the
same validated schema through the JSON-RPC `config/set` methods.
