/**
 * Evolution Tool
 *
 * Exposes the evolution log (self-modification tracking) as a tool
 * for the agent. Supports viewing recent entries, statistics, and
 * searching/filtering by type or date range.
 */
import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import {
  getEntries,
  getStats,
  type EvolutionEntry,
  type EvolutionStats,
} from '@src/rsi/evolution-log'

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'evolution'

export const description =
  'View the evolution log: recent self-modifications, summary statistics, or filter entries by type and date range.'

export const schema = z.object({
  action: z
    .enum(['log', 'stats', 'search'])
    .describe(
      'Action: "log" for recent entries, "stats" for summary, "search" for filtered entries',
    ),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe('Maximum number of entries to return (default 10, for log/search)'),
  type: z
    .enum([
      'skill-created',
      'skill-promoted',
      'skill-failed',
      'memory-updated',
      'memory-consolidated',
      'config-changed',
      'skill-proposal',
      'observation-recorded',
      'checkpoint-written',
      'context-flushed',
      'history-compacted',
      'length-recovery-succeeded',
      'length-recovery-failed',
      'durable-memory-promoted',
      'durable-memory-pruned',
      'skill-proposed-from-observations',
    ])
    .optional()
    .describe('Filter entries by type (for search action)'),
  since: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp — only entries after this date (for search action)'),
})

export interface EvolutionToolInput {
  action: 'log' | 'stats' | 'search'
  limit?: number
  type?:
    | 'skill-created'
    | 'skill-promoted'
    | 'skill-failed'
    | 'memory-updated'
    | 'memory-consolidated'
    | 'config-changed'
    | 'skill-proposal'
    | 'observation-recorded'
    | 'checkpoint-written'
    | 'context-flushed'
    | 'history-compacted'
    | 'length-recovery-succeeded'
    | 'length-recovery-failed'
    | 'durable-memory-promoted'
    | 'durable-memory-pruned'
    | 'skill-proposed-from-observations'
  since?: string
}

/** Dependencies injected at tool registration time */
export interface EvolutionToolDeps {
  basePath?: string
}

/**
 * Create the execute function with injected dependencies.
 */
export function createExecute(deps: EvolutionToolDeps = {}) {
  return async (input: EvolutionToolInput): Promise<Result<string>> => {
    switch (input.action) {
      case 'log': {
        const result = getEntries({ limit: input.limit ?? 10 }, deps.basePath)
        if (!result.ok) return result
        return ok(formatEntries(result.value))
      }

      case 'stats': {
        const result = getStats(deps.basePath)
        if (!result.ok) return result
        return ok(formatStats(result.value))
      }

      case 'search': {
        const result = getEntries(
          {
            type: input.type,
            limit: input.limit ?? 10,
            since: input.since,
          },
          deps.basePath,
        )
        if (!result.ok) return result
        if (result.value.length === 0) {
          return ok('No matching evolution entries found.')
        }
        return ok(formatEntries(result.value))
      }

      default:
        return err(new Error(`Unknown evolution action: ${String(input.action)}`))
    }
  }
}

/**
 * Default execute function (uses process.cwd()).
 * In production, use createExecute() with proper dependencies.
 */
export const execute = createExecute()

// ── Formatters ────────────────────────────────────────────────────

function formatEntries(entries: EvolutionEntry[]): string {
  if (entries.length === 0) {
    return 'No evolution entries found.'
  }
  return entries
    .map(
      (e) =>
        `[${e.timestamp}] ${e.type}: ${e.summary}${e.details.skillName ? ` (skill: ${e.details.skillName})` : ''}`,
    )
    .join('\n')
}

function formatStats(stats: EvolutionStats): string {
  const lines = [
    `Total entries: ${stats.totalEntries}`,
    `Skills created: ${stats.skillsCreated}`,
    `Skills promoted: ${stats.skillsPromoted}`,
    `Skills failed: ${stats.skillsFailed}`,
    '',
    'By type:',
    ...Object.entries(stats.byType).map(([type, count]) => `  ${type}: ${count}`),
  ]
  if (stats.firstEntry) lines.push(`\nFirst entry: ${stats.firstEntry}`)
  if (stats.lastEntry) lines.push(`Last entry: ${stats.lastEntry}`)
  return lines.join('\n')
}
