/**
 * Dream Tool
 *
 * Exposes the dream cycle (between-session memory consolidation) as a tool
 * for the agent. Follows the tool registry interface:
 * name, description, schema (Zod), execute (async fn returning Result).
 */
import { z } from 'zod'
import { type Result, err } from '@src/types'
import { dream, type DreamResult, type DreamDeps } from '@src/memory/dream'

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'dream'

export const description =
  'Run the dream cycle: analyze recent session transcripts, consolidate memory (merge redundant topics, resolve contradictions), and generate skill proposals based on cross-session patterns.'

export const schema = z.object({
  sessionCount: z
    .number()
    .optional()
    .default(5)
    .describe('How many recent sessions to analyze (default 5)'),
  mode: z
    .enum(['full', 'consolidate-only', 'propose-only'])
    .optional()
    .default('full')
    .describe('What aspects of the dream cycle to run'),
})

export interface DreamToolInput {
  sessionCount?: number
  mode?: 'full' | 'consolidate-only' | 'propose-only'
}

/** Dependencies injected at tool registration time */
export interface DreamToolDeps {
  dreamDeps: DreamDeps
}

/**
 * Create the execute function with injected dependencies.
 */
export function createExecute(deps: DreamToolDeps) {
  return async (input: DreamToolInput): Promise<Result<DreamResult>> => {
    return dream(deps.dreamDeps, {
      sessionCount: input.sessionCount,
      mode: input.mode,
    })
  }
}

/**
 * Default execute function — returns an error indicating deps must be configured.
 * In production, use createExecute() with proper dependencies.
 */
export const execute = async (_input: DreamToolInput): Promise<Result<DreamResult>> => {
  return err(
    new Error(
      'Dream tool requires dependencies to be configured. Use createExecute() with DreamDeps.',
    ),
  )
}
