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
])

export type EvolutionEntryType = z.infer<typeof evolutionEntryTypeSchema>

export const evolutionEntryDetailsSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  diff: z.string().optional(),
  reflectionId: z.string().optional(),
  skillName: z.string().optional(),
  sessionId: z.string().optional(),
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

    return ok({
      totalEntries: entries.length,
      byType,
      firstEntry,
      lastEntry,
      skillsCreated: byType['skill-created'],
      skillsPromoted: byType['skill-promoted'],
      skillsFailed: byType['skill-failed'],
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to get evolution stats: ${message}`))
  }
}
