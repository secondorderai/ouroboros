import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type AgentDefinition, type PermissionConfig, type Result, ok, err } from '@src/types'
import { getContextWindowTokens } from '@src/llm/model-capabilities'

const CONFIG_FILE_NAME = '.ouroboros'

export const DEFAULT_MEMORY_CONFIG = {
  consolidationSchedule: 'session-end' as const,
  warnRatio: 0.7,
  flushRatio: 0.8,
  compactRatio: 0.9,
  tailMessageCount: 12,
  dailyLoadDays: 2,
  durableMemoryBudgetTokens: 1500,
  checkpointBudgetTokens: 1200,
  workingMemoryBudgetTokens: 1000,
}

export type ContextWindowSource = 'config' | 'model-registry' | 'fallback' | 'unknown'

export const DEFAULT_RSI_CONFIG = {
  noveltyThreshold: 0.7,
  autoReflect: true,
  observeEveryTurns: 1,
  checkpointEveryTurns: 6,
  durablePromotionThreshold: 0.8,
  crystallizeFromRepeatedPatternsOnly: true,
}

export const DEFAULT_AGENT_CONFIG = {
  maxSteps: {
    interactive: 200,
    desktop: 200,
    singleShot: 50,
    automation: 100,
  },
  allowedTestCommands: [] as string[],
}

export const DEFAULT_ARTIFACTS_CONFIG = {
  cdnAllowlist: [
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://cdnjs.cloudflare.com',
  ] as string[],
  maxBytes: 1_048_576,
}

const READ_ONLY_PERMISSIONS: PermissionConfig = {
  tier0: true,
  tier1: false,
  tier2: false,
  tier3: false,
  tier4: false,
}

export const BUILT_IN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'default',
    description: 'Primary orchestration agent for planning, implementation, and delegation.',
    mode: 'primary',
    prompt:
      'Plan and execute user tasks. Delegate bounded read-only research or review to subagents when it materially improves confidence, and keep final accountability for the answer.',
    permissions: {
      tier0: true,
      tier1: true,
      tier2: true,
      tier3: false,
      tier4: false,
      canInvokeAgents: ['explore', 'review', 'test'],
    },
  },
  {
    id: 'explore',
    description: 'Read-only codebase exploration and context gathering.',
    mode: 'all',
    prompt:
      'Explore the codebase, gather relevant context, and report findings without editing files or running privileged actions.',
    permissions: READ_ONLY_PERMISSIONS,
  },
  {
    id: 'review',
    description: 'Read-only review focused on bugs, regressions, and missing tests.',
    mode: 'all',
    prompt:
      'Review the relevant code and report only actionable bugs, regressions, missing tests, and correctness risks. Stay read-only: do not edit files or run mutating commands. Return structured reviewFindings with title, severity, optional file, optional line, body, confidence, and evidence. Prefer evidence-backed findings and include file/line references when possible. If there are no findings, return an empty reviewFindings array and say that clearly in the summary.',
    permissions: READ_ONLY_PERMISSIONS,
  },
  {
    id: 'test',
    description: 'Restricted test runner for configured verification commands.',
    mode: 'subagent',
    prompt:
      'Run configured verification commands only. Use bash only for commands explicitly listed in the allowed test command policy. Report each test command result with command, exit code, duration, output excerpt, and passed or failed status. Do not run arbitrary shell commands.',
    permissions: READ_ONLY_PERMISSIONS,
  },
  {
    id: 'worker',
    description: 'Write-capable worker role isolated inside a git worktree.',
    mode: 'subagent',
    prompt:
      'Implement the assigned task only inside the provided isolated git worktree. Use write tools only for the provided write scope and permission lease. Run only the provided verification command. Return structured JSON with summary, claims, uncertainty, suggestedNextSteps, and any testResults.',
    permissions: {
      tier0: true,
      tier1: true,
      tier2: false,
      tier3: false,
      tier4: false,
    },
    hidden: true,
  },
]

function mergeAgentDefinitions(customDefinitions: AgentDefinition[] = []): AgentDefinition[] {
  const definitionsById = new Map<string, AgentDefinition>()

  for (const definition of BUILT_IN_AGENT_DEFINITIONS) {
    definitionsById.set(definition.id, definition)
  }

  for (const definition of customDefinitions) {
    definitionsById.set(definition.id, definition)
  }

  return Array.from(definitionsById.values())
}

export function getSelectablePrimaryAgentDefinitions(config: OuroborosConfig): AgentDefinition[] {
  return config.agent.definitions.filter(
    (definition) =>
      !definition.hidden && (definition.mode === 'primary' || definition.mode === 'all'),
  )
}

const permissionSchema = z.object({
  tier0: z.boolean().default(true).describe('Read-only operations'),
  tier1: z.boolean().default(true).describe('Scoped writes'),
  tier2: z.boolean().default(true).describe('Skill generation (auto + self-test)'),
  tier3: z.boolean().default(false).describe('Self-modification (requires human approval)'),
  tier4: z.boolean().default(false).describe('System-level (requires human approval)'),
  canInvokeAgents: z
    .array(
      z
        .string()
        .regex(
          /^[a-z][a-z0-9-]*$/,
          'Invalid invokable agent id. Use lowercase letters, numbers, and hyphens, starting with a letter.',
        ),
    )
    .optional()
    .describe('Agent ids this agent may invoke as task subagents'),
})

const agentDefinitionSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Invalid agent definition id. Use lowercase letters, numbers, and hyphens, starting with a letter.',
    )
    .describe('Stable agent definition id'),
  description: z.string().min(1, 'Agent definition description is required'),
  mode: z.enum(['primary', 'subagent', 'all']).describe('Where this agent can be used'),
  prompt: z.string().min(1, 'Agent definition prompt is required'),
  model: z.string().min(1).optional(),
  permissions: permissionSchema.optional(),
  hidden: z.boolean().optional(),
  phaseGate: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
})

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — client config
// ---------------------------------------------------------------------------

const mcpServerNameRegex = /^[a-z][a-z0-9-]*$/

const mcpRequireApprovalSchema = z
  .union([z.literal('always'), z.literal('first-call'), z.literal(false)])
  .default('first-call')
  .describe(
    'When to prompt the user before MCP tool calls. "first-call" prompts once per tool per session.',
  )

const mcpLocalServerSchema = z.object({
  type: z.literal('local'),
  name: z
    .string()
    .regex(mcpServerNameRegex, 'MCP server name must be lowercase alphanumeric with hyphens')
    .describe('Server identifier; used as the prefix in mcp__<server>__<tool> tool names'),
  command: z.string().min(1).describe('Executable to spawn for this stdio MCP server'),
  args: z.array(z.string()).default([]).describe('Arguments passed to the spawned command'),
  env: z
    .record(z.string(), z.string())
    .default({})
    .describe('Environment variables for the spawned process'),
  cwd: z.string().optional().describe('Working directory for the spawned process'),
  timeout: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe('Per-tool-call timeout in milliseconds'),
  requireApproval: mcpRequireApprovalSchema,
})

const mcpRemoteServerSchema = z.object({
  type: z.literal('remote'),
  name: z
    .string()
    .regex(mcpServerNameRegex, 'MCP server name must be lowercase alphanumeric with hyphens'),
  url: z.string().url().describe('Streamable HTTP endpoint for the remote MCP server'),
  headers: z.record(z.string(), z.string()).default({}).describe('Static request headers'),
  timeout: z.number().int().positive().default(30000),
  requireApproval: mcpRequireApprovalSchema,
})

export const mcpServerSchema = z.discriminatedUnion('type', [
  mcpLocalServerSchema,
  mcpRemoteServerSchema,
])

export const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
})

export type McpServerConfig = z.infer<typeof mcpServerSchema>
export type McpLocalServerConfig = z.infer<typeof mcpLocalServerSchema>
export type McpRemoteServerConfig = z.infer<typeof mcpRemoteServerSchema>
export type McpConfig = z.infer<typeof mcpConfigSchema>

/**
 * Zod schema for the .ouroboros configuration file.
 */
export const configSchema = z.object({
  model: z
    .object({
      provider: z
        .enum(['anthropic', 'openai', 'openai-compatible', 'openai-chatgpt'])
        .default('anthropic')
        .describe('LLM provider to use'),
      name: z.string().default('claude-sonnet-4-20250514').describe('Model name/identifier'),
      baseUrl: z.string().url().optional().describe('Base URL for OpenAI-compatible endpoints'),
      apiMode: z
        .enum(['responses', 'chat', 'completion'])
        .optional()
        .describe('API style to use for OpenAI-compatible endpoints'),
      apiKey: z.string().min(1).optional().describe('Fallback API key for the selected provider'),
      thinkingBudgetTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Anthropic extended-thinking budget in tokens. Ignored for non-Anthropic models.',
        ),
      reasoningEffort: z
        .enum(['minimal', 'low', 'medium', 'high'])
        .optional()
        .describe(
          'OpenAI reasoning effort (minimal|low|medium|high). Ignored for non-OpenAI-reasoning models. "minimal" is GPT-5 only.',
        ),
    })
    .default({ provider: 'anthropic' as const, name: 'claude-sonnet-4-20250514' }),

  permissions: z
    .object(permissionSchema.shape)
    .default({ tier0: true, tier1: true, tier2: true, tier3: false, tier4: false }),

  skillDirectories: z
    .array(z.string())
    .default(['skills/core', 'skills/generated'])
    .describe('Directories to scan for Agent Skills'),

  agent: z
    .object({
      maxSteps: z
        .object({
          interactive: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_AGENT_CONFIG.maxSteps.interactive)
            .describe('Maximum autonomous steps for interactive CLI chat'),
          desktop: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_AGENT_CONFIG.maxSteps.desktop)
            .describe('Maximum autonomous steps for desktop chat'),
          singleShot: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_AGENT_CONFIG.maxSteps.singleShot)
            .describe('Maximum autonomous steps for single-shot CLI prompts'),
          automation: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_AGENT_CONFIG.maxSteps.automation)
            .describe('Maximum autonomous steps for automation/RPC runs'),
        })
        .default(DEFAULT_AGENT_CONFIG.maxSteps),
      definitions: z
        .array(agentDefinitionSchema)
        .default([])
        .describe(
          'Custom agent definitions. Entries override built-ins with the same id; later entries win.',
        ),
      allowedTestCommands: z
        .array(z.string().trim().min(1))
        .default(DEFAULT_AGENT_CONFIG.allowedTestCommands)
        .describe('Exact shell commands the restricted test subagent may execute'),
    })
    .default({ ...DEFAULT_AGENT_CONFIG, definitions: [] })
    .transform((agent) => ({
      ...agent,
      definitions: mergeAgentDefinitions(agent.definitions),
    })),

  memory: z
    .object({
      consolidationSchedule: z
        .enum(['session-end', 'daily', 'manual'])
        .default('session-end')
        .describe('When to run memory consolidation / dream cycle'),
      contextWindowTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional context window budget used by memory compaction heuristics'),
      contextWindowSource: z
        .enum(['config', 'model-registry', 'fallback', 'unknown'])
        .optional()
        .describe('Runtime source for contextWindowTokens diagnostics'),
      warnRatio: z
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_MEMORY_CONFIG.warnRatio)
        .describe('Budget threshold that emits a context warning'),
      flushRatio: z
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_MEMORY_CONFIG.flushRatio)
        .describe('Budget threshold that triggers checkpoint flush preparation'),
      compactRatio: z
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_MEMORY_CONFIG.compactRatio)
        .describe('Budget threshold that triggers conversation compaction'),
      tailMessageCount: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MEMORY_CONFIG.tailMessageCount)
        .describe('Number of recent raw messages to preserve after compaction'),
      dailyLoadDays: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MEMORY_CONFIG.dailyLoadDays)
        .describe('How many recent daily memory files to load into context'),
      durableMemoryBudgetTokens: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MEMORY_CONFIG.durableMemoryBudgetTokens)
        .describe('Prompt token budget reserved for durable memory'),
      checkpointBudgetTokens: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MEMORY_CONFIG.checkpointBudgetTokens)
        .describe('Prompt token budget reserved for checkpoint memory'),
      workingMemoryBudgetTokens: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MEMORY_CONFIG.workingMemoryBudgetTokens)
        .describe('Prompt token budget reserved for working memory'),
    })
    .default(DEFAULT_MEMORY_CONFIG),

  rsi: z
    .object({
      noveltyThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe('Minimum novelty score (0-1) to trigger skill crystallization'),
      autoReflect: z
        .boolean()
        .default(true)
        .describe('Automatically run reflection after task completion'),
      observeEveryTurns: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_RSI_CONFIG.observeEveryTurns)
        .describe('Cadence for observation capture during active sessions'),
      checkpointEveryTurns: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_RSI_CONFIG.checkpointEveryTurns)
        .describe('Cadence for rewriting structured checkpoints'),
      durablePromotionThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(DEFAULT_RSI_CONFIG.durablePromotionThreshold)
        .describe('Minimum confidence required to promote working memory into durable memory'),
      crystallizeFromRepeatedPatternsOnly: z
        .boolean()
        .default(DEFAULT_RSI_CONFIG.crystallizeFromRepeatedPatternsOnly)
        .describe('Whether crystallization should require repeated evidence across observations'),
    })
    .default(DEFAULT_RSI_CONFIG),

  artifacts: z
    .object({
      cdnAllowlist: z
        .array(z.string().url())
        .default(DEFAULT_ARTIFACTS_CONFIG.cdnAllowlist)
        .describe('Allowed CDN origins for artifact <script>/<link> sources'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_ARTIFACTS_CONFIG.maxBytes)
        .describe('Maximum size in bytes for an HTML artifact'),
    })
    .default(DEFAULT_ARTIFACTS_CONFIG),

  mcp: mcpConfigSchema.default({ servers: [] }),
})

export type OuroborosConfig = z.infer<typeof configSchema>

/**
 * Apply environment variable overrides on top of a parsed config.
 * Environment variables use the OUROBOROS_ prefix with underscores for nesting.
 *
 * Supported env vars:
 *   OUROBOROS_MODEL_PROVIDER  -> model.provider
 *   OUROBOROS_MODEL_NAME      -> model.name
 *   OUROBOROS_MODEL_BASE_URL  -> model.baseUrl
 *   OUROBOROS_MODEL_API_MODE  -> model.apiMode
 *   OUROBOROS_OPENAI_COMPATIBLE_API_KEY -> model.apiKey (for provider=openai-compatible)
 *   OUROBOROS_CONSOLIDATION   -> memory.consolidationSchedule
 *   OUROBOROS_NOVELTY         -> rsi.noveltyThreshold
 *   OUROBOROS_AUTO_REFLECT    -> rsi.autoReflect
 */
function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const env = process.env

  const model =
    typeof config.model === 'object' && config.model !== null
      ? ({ ...config.model } as Record<string, unknown>)
      : config.model !== undefined
        ? (config.model as Record<string, unknown>)
        : ({} as Record<string, unknown>)
  const memory =
    typeof config.memory === 'object' && config.memory !== null
      ? ({ ...config.memory } as Record<string, unknown>)
      : config.memory !== undefined
        ? (config.memory as Record<string, unknown>)
        : ({} as Record<string, unknown>)
  const rsi =
    typeof config.rsi === 'object' && config.rsi !== null
      ? ({ ...config.rsi } as Record<string, unknown>)
      : config.rsi !== undefined
        ? (config.rsi as Record<string, unknown>)
        : ({} as Record<string, unknown>)

  if (env.OUROBOROS_MODEL_PROVIDER) {
    model.provider = env.OUROBOROS_MODEL_PROVIDER
  }
  if (env.OUROBOROS_MODEL_NAME) {
    model.name = env.OUROBOROS_MODEL_NAME
  }
  if (env.OUROBOROS_MODEL_BASE_URL) {
    model.baseUrl = env.OUROBOROS_MODEL_BASE_URL
  }
  if (env.OUROBOROS_MODEL_API_MODE) {
    model.apiMode = env.OUROBOROS_MODEL_API_MODE
  }
  if (env.ANTHROPIC_API_KEY && model.provider === 'anthropic') {
    model.apiKey = env.ANTHROPIC_API_KEY
  }
  if (env.OPENAI_API_KEY && model.provider === 'openai') {
    model.apiKey = env.OPENAI_API_KEY
  }
  if (env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY && model.provider === 'openai-compatible') {
    model.apiKey = env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
  }
  if (env.OUROBOROS_CONSOLIDATION) {
    memory.consolidationSchedule = env.OUROBOROS_CONSOLIDATION
  }
  if (env.OUROBOROS_NOVELTY) {
    const parsed = parseFloat(env.OUROBOROS_NOVELTY)
    if (!isNaN(parsed)) {
      rsi.noveltyThreshold = parsed
    }
  }
  if (env.OUROBOROS_AUTO_REFLECT) {
    rsi.autoReflect = env.OUROBOROS_AUTO_REFLECT === 'true'
  }

  return {
    ...config,
    model,
    memory,
    rsi,
  }
}

/**
 * Resolve the directory whose `.ouroboros` file should be used for config.
 *
 * Starting from `cwd`, walks up parent directories until it finds a
 * `.ouroboros` file. If none is found, returns the original `cwd`.
 */
export function resolveConfigDir(cwd?: string): string {
  const startDir = resolve(cwd ?? process.cwd())
  let currentDir = startDir

  while (true) {
    const configPath = resolve(currentDir, CONFIG_FILE_NAME)
    try {
      if (statSync(configPath).isFile()) {
        return currentDir
      }
    } catch {
      // statSync throws if path doesn't exist — continue walking up
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return startDir
    }

    currentDir = parentDir
  }
}

/**
 * Load configuration from the nearest `.ouroboros` file, environment variables,
 * and defaults.
 *
 * Priority (highest to lowest):
 *   1. Environment variables (OUROBOROS_*)
 *   2. The nearest `.ouroboros` JSON file in the current directory or an ancestor
 *   3. Zod schema defaults
 *
 * @param cwd - Working directory to search from (defaults to process.cwd())
 * @returns Result containing the validated config or a descriptive error
 */
export function loadConfig(cwd?: string): Result<OuroborosConfig> {
  const configDir = resolveConfigDir(cwd)
  const configPath = resolve(configDir, CONFIG_FILE_NAME)

  let fileConfig: Record<string, unknown> = {}

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      fileConfig = JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to parse .ouroboros config file: ${message}`))
    }
  }

  // Apply env overrides on top of file config
  const merged = applyEnvOverrides(fileConfig)

  // Validate through Zod (applies defaults for missing fields)
  const result = configSchema.safeParse(merged)

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    return err(new Error(`Invalid .ouroboros configuration:\n${issues}`))
  }

  // Auto-detect context window from model registry when not explicitly configured.
  // Explicit user config always takes precedence.
  const config = result.data
  const explicitMemory =
    typeof merged.memory === 'object' && merged.memory !== null
      ? (merged.memory as Record<string, unknown>)
      : {}
  const hasExplicitContextWindowTokens = typeof explicitMemory.contextWindowTokens === 'number'

  if (config.memory.contextWindowTokens === undefined) {
    const detected = getContextWindowTokens(config.model.name, config.model.provider)
    if (detected !== null) {
      config.memory.contextWindowTokens = detected
      config.memory.contextWindowSource = 'model-registry'
    } else {
      config.memory.contextWindowSource = 'unknown'
    }
  } else if (!config.memory.contextWindowSource) {
    config.memory.contextWindowSource = hasExplicitContextWindowTokens ? 'config' : 'unknown'
  }

  return ok(config)
}

/**
 * Persist a validated OuroborosConfig to disk as `.ouroboros` JSON.
 *
 * @param cwd - Working directory where the `.ouroboros` file lives
 * @param config - The validated config to persist
 * @returns Result indicating success or failure
 */
export function saveConfig(cwd: string, config: OuroborosConfig): Result<void> {
  const configPath = resolve(cwd, CONFIG_FILE_NAME)
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write .ouroboros config file: ${message}`))
  }
}
