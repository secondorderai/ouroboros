import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Result, ok, err } from '@src/types'

const CONFIG_FILE_NAME = '.ouroboros'

/**
 * Zod schema for the .ouroboros configuration file.
 */
export const configSchema = z.object({
  model: z
    .object({
      provider: z
        .enum(['anthropic', 'openai', 'openai-compatible'])
        .default('anthropic')
        .describe('LLM provider to use'),
      name: z.string().default('claude-sonnet-4-20250514').describe('Model name/identifier'),
      baseUrl: z.string().url().optional().describe('Base URL for OpenAI-compatible endpoints'),
    })
    .default({ provider: 'anthropic' as const, name: 'claude-sonnet-4-20250514' }),

  permissions: z
    .object({
      tier0: z.boolean().default(true).describe('Read-only operations'),
      tier1: z.boolean().default(true).describe('Scoped writes'),
      tier2: z.boolean().default(true).describe('Skill generation (auto + self-test)'),
      tier3: z.boolean().default(false).describe('Self-modification (requires human approval)'),
      tier4: z.boolean().default(false).describe('System-level (requires human approval)'),
    })
    .default({ tier0: true, tier1: true, tier2: true, tier3: false, tier4: false }),

  skillDirectories: z
    .array(z.string())
    .default(['skills/core', 'skills/generated'])
    .describe('Directories to scan for Agent Skills'),

  memory: z
    .object({
      consolidationSchedule: z
        .enum(['session-end', 'daily', 'manual'])
        .default('session-end')
        .describe('When to run memory consolidation / dream cycle'),
    })
    .default({
      consolidationSchedule: 'session-end' as const,
    }),

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
    })
    .default({ noveltyThreshold: 0.7, autoReflect: true }),
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
    if (existsSync(resolve(currentDir, CONFIG_FILE_NAME))) {
      return currentDir
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

  if (existsSync(configPath)) {
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

  return ok(result.data)
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
