/**
 * Evolution Log — Track All Self-Modifications
 *
 * Every self-modification the agent makes is tracked in a structured log.
 * The log serves as both an audit trail and a training signal for the RSI engine.
 *
 * Storage: evolution.log.json in the project root (JSON array, newest first).
 * All writes use atomic temp-file + rename to prevent corruption.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { z } from 'zod'
import { type Result, ok, err } from '@src/types'

// ── Schemas ───────────────────────────────────────────────────────

export const evolutionEntryTypeSchema = z.enum([
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

export type EvolutionEntryType = z.infer<typeof evolutionEntryTypeSchema>

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

export const evolutionEntryDetailsSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  diff: z.string().optional(),
  reflectionId: z.string().optional(),
  skillName: z.string().optional(),
  sessionId: z.string().optional(),
  checkpointUpdatedAt: z.string().optional(),
  sourceObservationIds: z.array(z.string()).optional(),
  sourceSessionIds: z.array(z.string()).optional(),
  observationCount: z.number().int().nonnegative().optional(),
  observationKinds: z.array(z.string()).optional(),
  openLoopCount: z.number().int().nonnegative().optional(),
  durableCandidateCount: z.number().int().nonnegative().optional(),
  skillCandidateCount: z.number().int().nonnegative().optional(),
  usageRatio: z.number().nullable().optional(),
  estimatedTotalTokens: z.number().int().nonnegative().optional(),
  contextWindowTokens: z.number().int().positive().nullable().optional(),
  threshold: z.string().optional(),
  unseenMessageCount: z.number().int().nonnegative().optional(),
  droppedMessageCount: z.number().int().nonnegative().optional(),
  retainedMessageCount: z.number().int().nonnegative().optional(),
  tailMessageCount: z.number().int().positive().optional(),
  partialResponseLength: z.number().int().nonnegative().optional(),
  repeatedWorkDetected: z.boolean().optional(),
  item: z.string().optional(),
  kind: z.string().optional(),
  repeatCount: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
})

export type EvolutionEntryDetails = z.infer<typeof evolutionEntryDetailsSchema>

export const evolutionEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: evolutionEntryTypeSchema,
  summary: z.string(),
  details: evolutionEntryDetailsSchema,
  motivation: z.string(),
})

export type EvolutionEntry = z.infer<typeof evolutionEntrySchema>

export interface EvolutionStats {
  totalEntries: number
  byType: Record<EvolutionEntryType, number>
  firstEntry?: string
  lastEntry?: string
  skillsCreated: number
  skillsPromoted: number
  skillsFailed: number
  compactionsPerSession: Record<string, number>
  successfulResumesAfterCompaction: number
  repeatedWorkRateAfterCompaction: number
  durableMemoryReuseRate: number
  skillProposalsFromObservations: number
  durablePromotions: number
  durablePrunes: number
  sessionsAnalyzed: number
  successRate: number
}

export interface GetEntriesOptions {
  type?: EvolutionEntryType
  limit?: number
  since?: string
}

/**
 * Input type for appendEntry — id and timestamp are auto-generated.
 */
export type NewEvolutionEntry = Omit<EvolutionEntry, 'id' | 'timestamp'>

// ── Path Resolution ───────────────────────────────────────────────

const DEFAULT_LOG_FILENAME = 'evolution.log.json'

function resolveLogPath(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, DEFAULT_LOG_FILENAME)
}

// ── Core Functions ────────────────────────────────────────────────

/**
 * Read the evolution log from disk.
 * Returns an empty array if the file doesn't exist.
 * Returns Result.err if the file contains invalid JSON.
 */
export function readLog(basePath?: string): Result<EvolutionEntry[]> {
  try {
    const filePath = resolveLogPath(basePath)
    if (!existsSync(filePath)) {
      return ok([])
    }
    const content = readFileSync(filePath, 'utf-8')
    if (content.trim().length === 0) {
      return ok([])
    }
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      return err(
        new Error('Corrupted evolution log: expected a JSON array but found ' + typeof parsed),
      )
    }
    return ok(parsed as EvolutionEntry[])
  } catch (e) {
    if (e instanceof SyntaxError) {
      return err(new Error(`Corrupted evolution log: invalid JSON — ${e.message}`))
    }
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read evolution log: ${message}`))
  }
}

/**
 * Write the evolution log to disk using atomic temp-file + rename.
 */
function writeLog(entries: EvolutionEntry[], basePath?: string): Result<void> {
  try {
    const filePath = resolveLogPath(basePath)
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const tempPath = join(dir, `.evolution-log.tmp.${Date.now()}.json`)
    writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf-8')
    renameSync(tempPath, filePath)
    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write evolution log: ${message}`))
  }
}

/**
 * Append a new entry to the evolution log.
 * Auto-generates id (UUID) and timestamp (ISO 8601).
 * New entries are prepended (newest first).
 */
export function appendEntry(entry: NewEvolutionEntry, basePath?: string): Result<EvolutionEntry> {
  try {
    // Validate the entry against the schema (minus id/timestamp)
    const validation = z
      .object({
        type: evolutionEntryTypeSchema,
        summary: z.string(),
        details: evolutionEntryDetailsSchema,
        motivation: z.string(),
      })
      .safeParse(entry)

    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      return err(new Error(`Invalid evolution entry: ${issues}`))
    }

    const fullEntry: EvolutionEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: entry.type,
      summary: entry.summary,
      details: entry.details,
      motivation: entry.motivation,
    }

    const readResult = readLog(basePath)
    if (!readResult.ok) return readResult

    const entries = [fullEntry, ...readResult.value]
    const writeResult = writeLog(entries, basePath)
    if (!writeResult.ok) return writeResult

    return ok(fullEntry)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to append evolution entry: ${message}`))
  }
}

/**
 * Query evolution log entries with optional filters.
 *
 * @param options.type - Filter by entry type
 * @param options.limit - Maximum number of entries to return
 * @param options.since - Only entries after this ISO 8601 timestamp
 */
export function getEntries(
  options?: GetEntriesOptions,
  basePath?: string,
): Result<EvolutionEntry[]> {
  try {
    const readResult = readLog(basePath)
    if (!readResult.ok) return readResult

    let entries = readResult.value

    // Filter by type
    if (options?.type) {
      entries = entries.filter((e) => e.type === options.type)
    }

    // Filter by date
    if (options?.since) {
      const sinceDate = new Date(options.since)
      entries = entries.filter((e) => new Date(e.timestamp) >= sinceDate)
    }

    // Apply limit
    if (options?.limit !== undefined && options.limit >= 0) {
      entries = entries.slice(0, options.limit)
    }

    return ok(entries)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to get evolution entries: ${message}`))
  }
}

/**
 * Get summary statistics for the evolution log.
 */
export function getStats(basePath?: string): Result<EvolutionStats> {
  try {
    const readResult = readLog(basePath)
    if (!readResult.ok) return readResult

    const entries = readResult.value
    const allTypes: EvolutionEntryType[] = [
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
    ]

    const byType: Record<EvolutionEntryType, number> = {} as Record<EvolutionEntryType, number>
    for (const t of allTypes) {
      byType[t] = 0
    }
    for (const entry of entries) {
      if (byType[entry.type] !== undefined) {
        byType[entry.type]++
      }
    }

    // Entries are newest-first, so last element is the oldest
    const firstEntry = entries.length > 0 ? entries[entries.length - 1].timestamp : undefined
    const lastEntry = entries.length > 0 ? entries[0].timestamp : undefined
    const compactionsPerSession: Record<string, number> = {}
    const compactionOutcomes = entries.filter(
      (entry) =>
        entry.type === 'length-recovery-succeeded' || entry.type === 'length-recovery-failed',
    )
    const repeatedWorkChecks = compactionOutcomes.filter(
      (entry) => typeof entry.details.repeatedWorkDetected === 'boolean',
    )
    const repeatedWorkCount = repeatedWorkChecks.filter(
      (entry) => entry.details.repeatedWorkDetected === true,
    ).length
    const promotedEntries = entries.filter((entry) => entry.type === 'durable-memory-promoted')
    const promotedKeys = new Set(
      promotedEntries
        .map((entry) => entry.details.item?.trim())
        .filter((item): item is string => !!item),
    )
    const reusedKeys = new Set<string>()

    for (const entry of entries) {
      if (
        entry.type === 'checkpoint-written' &&
        entry.details.metadata &&
        Array.isArray(entry.details.metadata.reusedDurableMemoryItems)
      ) {
        for (const item of entry.details.metadata.reusedDurableMemoryItems) {
          if (typeof item === 'string' && promotedKeys.has(item.trim())) {
            reusedKeys.add(item.trim())
          }
        }
      }

      if (entry.type === 'history-compacted' && entry.details.sessionId) {
        compactionsPerSession[entry.details.sessionId] =
          (compactionsPerSession[entry.details.sessionId] ?? 0) + 1
      }
    }

    const successfulResumesAfterCompaction = byType['length-recovery-succeeded']
    const repeatedWorkRateAfterCompaction =
      repeatedWorkChecks.length > 0 ? repeatedWorkCount / repeatedWorkChecks.length : 0
    const durableMemoryReuseRate = promotedKeys.size > 0 ? reusedKeys.size / promotedKeys.size : 0
    const skillProposalsFromObservations = byType['skill-proposed-from-observations']
    const durablePromotions = byType['durable-memory-promoted']
    const durablePrunes = byType['durable-memory-pruned']
    const analyzedSessionIds = new Set<string>()
    const analyzedEntryTypes = new Set<EvolutionEntryType>([
      'memory-updated',
      'skill-created',
      'skill-promoted',
      'skill-failed',
      'skill-proposed-from-observations',
    ])
    let analyzedEntryCount = 0

    for (const entry of entries) {
      if (entry.details.sessionId) {
        analyzedSessionIds.add(entry.details.sessionId)
      }

      if (Array.isArray(entry.details.sourceSessionIds)) {
        for (const sessionId of entry.details.sourceSessionIds) {
          if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
            analyzedSessionIds.add(sessionId)
          }
        }
      }

      if (analyzedEntryTypes.has(entry.type)) {
        analyzedEntryCount++
      }
    }

    const sessionsAnalyzed =
      analyzedSessionIds.size > 0 ? analyzedSessionIds.size : analyzedEntryCount
    const successfulCrystallizations = byType['skill-created'] + byType['skill-promoted']
    const crystallizationAttempts = successfulCrystallizations + byType['skill-failed']
    const recoveryAttempts = successfulResumesAfterCompaction + byType['length-recovery-failed']
    const successRate =
      crystallizationAttempts > 0
        ? successfulCrystallizations / crystallizationAttempts
        : recoveryAttempts > 0
          ? successfulResumesAfterCompaction / recoveryAttempts
          : 0

    return ok({
      totalEntries: entries.length,
      byType,
      firstEntry,
      lastEntry,
      skillsCreated: byType['skill-created'],
      skillsPromoted: byType['skill-promoted'],
      skillsFailed: byType['skill-failed'],
      compactionsPerSession,
      successfulResumesAfterCompaction,
      repeatedWorkRateAfterCompaction,
      durableMemoryReuseRate,
      skillProposalsFromObservations,
      durablePromotions,
      durablePrunes,
      sessionsAnalyzed,
      successRate,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to get evolution stats: ${message}`))
  }
}
