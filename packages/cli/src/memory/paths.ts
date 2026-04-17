import { resolve } from 'node:path'

const MEMORY_DIR = 'memory'
const OBSERVATIONS_DIR = 'observations'
const CHECKPOINTS_DIR = 'checkpoints'
const DAILY_DIR = 'daily'

function resolveMemoryDir(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, MEMORY_DIR)
}

function formatDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Format a date as YYYY-MM-DD for daily memory file names.
 * String inputs are treated as already-formatted dates.
 */
export function formatDailyMemoryDate(date: Date | string): string {
  if (typeof date === 'string') {
    return date
  }

  return [
    String(date.getFullYear()),
    formatDatePart(date.getMonth() + 1),
    formatDatePart(date.getDate()),
  ].join('-')
}

/**
 * Resolve the observations directory under memory/.
 */
export function resolveObservationsDir(basePath?: string): string {
  return resolve(resolveMemoryDir(basePath), OBSERVATIONS_DIR)
}

/**
 * Resolve the append-only JSONL observation log path for a session.
 */
export function resolveObservationLogPath(sessionId: string, basePath?: string): string {
  return resolve(resolveObservationsDir(basePath), `${sessionId}.jsonl`)
}

/**
 * Resolve the checkpoints directory under memory/.
 */
export function resolveCheckpointsDir(basePath?: string): string {
  return resolve(resolveMemoryDir(basePath), CHECKPOINTS_DIR)
}

/**
 * Resolve the markdown checkpoint path for a session.
 */
export function resolveCheckpointPath(sessionId: string, basePath?: string): string {
  return resolve(resolveCheckpointsDir(basePath), `${sessionId}.md`)
}

/**
 * Resolve the daily memory directory under memory/.
 */
export function resolveDailyMemoryDir(basePath?: string): string {
  return resolve(resolveMemoryDir(basePath), DAILY_DIR)
}

/**
 * Resolve the markdown path for a specific daily memory entry.
 */
export function resolveDailyMemoryPath(date: Date | string, basePath?: string): string {
  return resolve(resolveDailyMemoryDir(basePath), `${formatDailyMemoryDate(date)}.md`)
}
