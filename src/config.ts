import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Result, ok, err } from '@src/types'

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
      baseUrl: z.string().url().optional().describe('Base URL for OpenAI-compatible endpoints')
    })
    .default({}),

  permissions: z
    .object({
      tier0: z.boolean().default(true).describe('Read-only operations'),
      tier1: z.boolean().default(true).describe('Scoped writes'),
      tier2: z.boolean().default(true).describe('Skill generation (auto + self-test)'),
      tier3: z.boolean().default(false).describe('Self-modification (requires human approval)'),
      tier4: z.boolean().default(false).describe('System-level (requires human approval)')
    })
    .default({}),

  skillDirectories: z
    .array(z.string())
    .default(['skills/core', 'skills/generated'])
    .describe('Directories to scan for Agent Skills'),

  memory: z
    .object({
      sqlitePath: z
        .string()
        .default('memory/transcripts.db')
        .describe('Path to SQLite database for session transcripts'),
      consolidationSchedule: z
        .enum(['session-end', 'daily', 'manual'])
        .default('session-end')
        .describe('When to run memory consolidation / dream cycle')
    })
    .default({}),

  rsi: z
    .object({
      noveltyThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe('Minimum novelty score (0-1) to trigger skill crystallization'),
      autoReflect: z.boolean().default(true).describe('Automatically run reflection after task completion')
    })
    .default({})
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
 *   OUROBOROS_SQLITE_PATH     -> memory.sqlitePath
 *   OUROBOROS_CONSOLIDATION   -> memory.consolidationSchedule
 *   OUROBOROS_NOVELTY         -> rsi.noveltyThreshold
 *   OUROBOROS_AUTO_REFLECT    -> rsi.autoReflect
 */
function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const env = process.env

  const model = (config.model ?? {}) as Record<string, unknown>
  const memory = (config.memory ?? {}) as Record<string, unknown>
  const rsi = (config.rsi ?? {}) as Record<string, unknown>

  if (env.OUROBOROS_MODEL_PROVIDER) {
    model.provider = env.OUROBOROS_MODEL_PROVIDER
  }
  if (env.OUROBOROS_MODEL_NAME) {
    model.name = env.OUROBOROS_MODEL_NAME
  }
  if (env.OUROBOROS_MODEL_BASE_URL) {
    model.baseUrl = env.OUROBOROS_MODEL_BASE_URL
  }
  if (env.OUROBOROS_SQLITE_PATH) {
    memory.sqlitePath = env.OUROBOROS_SQLITE_PATH
  }
  if (env.OUROBOROS_CONSOLIDATION) {
    memory.consolidationSchedule = env.OUROBOROS_CONSOLIDATION
  }
  if (env.OUROBOROS_NOVELTY) {
    rsi.noveltyThreshold = parseFloat(env.OUROBOROS_NOVELTY)
  }
  if (env.OUROBOROS_AUTO_REFLECT) {
    rsi.autoReflect = env.OUROBOROS_AUTO_REFLECT === 'true'
  }

  return {
    ...config,
    model,
    memory,
    rsi
  }
}

/**
 * Load configuration from .ouroboros file, environment variables, and defaults.
 *
 * Priority (highest to lowest):
 *   1. Environment variables (OUROBOROS_*)
 *   2. .ouroboros JSON file
 *   3. Zod schema defaults
 *
 * @param cwd - Working directory to search for .ouroboros file (defaults to process.cwd())
 * @returns Result containing the validated config or a descriptive error
 */
export function loadConfig(cwd?: string): Result<OuroborosConfig> {
  const workingDir = cwd ?? process.cwd()
  const configPath = resolve(workingDir, '.ouroboros')

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
    const issues = result.error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    return err(new Error(`Invalid .ouroboros configuration:\n${issues}`))
  }

  return ok(result.data)
}
