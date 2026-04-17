/**
 * Layer 2 — Observation Log
 *
 * Structured append-only JSONL storage for RSI observations.
 * This module hides the file format behind a Result-based API so
 * observe/reflect stages can work with typed records.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { resolveObservationLogPath } from '@src/memory/paths'
import type { ObservationKind, ObservationPriority, ObservationRecord } from '@src/rsi/types'
import { type Result, err, ok } from '@src/types'

const observationKinds = [
  'goal',
  'constraint',
  'decision',
  'artifact',
  'progress',
  'open-loop',
  'preference',
  'fact',
  'warning',
  'candidate-durable',
  'candidate-skill',
] as const satisfies readonly ObservationKind[]

const observationPriorities = [
  'low',
  'normal',
  'high',
  'critical',
] as const satisfies readonly ObservationPriority[]

const timestampSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid ISO 8601 timestamp')

const observationKindSchema = z.enum(observationKinds)
const observationPrioritySchema = z.enum(observationPriorities)
const nonEmptyStringSchema = z.string().trim().min(1)

const newObservationSchema = z
  .object({
    id: nonEmptyStringSchema.optional(),
    observedAt: timestampSchema.optional(),
    effectiveAt: timestampSchema.optional(),
    kind: observationKindSchema,
    summary: nonEmptyStringSchema,
    evidence: z.array(nonEmptyStringSchema),
    priority: observationPrioritySchema,
    tags: z.array(nonEmptyStringSchema),
    supersedes: z.array(nonEmptyStringSchema).optional(),
  })
  .strict()

const observationRecordSchema = newObservationSchema
  .extend({
    id: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    observedAt: timestampSchema,
  })
  .strict()

export interface NewObservationInput {
  id?: string
  observedAt?: string
  effectiveAt?: string
  kind: ObservationKind
  summary: string
  evidence: string[]
  priority: ObservationPriority
  tags: string[]
  supersedes?: string[]
}

export interface ObservationFilterOptions {
  kind?: ObservationKind | ObservationKind[]
  priority?: ObservationPriority | ObservationPriority[]
  tags?: string[]
  since?: string
  until?: string
  supersedes?: string
  limit?: number
}

function formatZodIssues(prefix: string, error: z.ZodError): Error {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ')
  return new Error(`${prefix}: ${issues}`)
}

function normalizeKinds(
  value?: ObservationKind | ObservationKind[],
): Set<ObservationKind> | undefined {
  if (!value) return undefined
  return new Set(Array.isArray(value) ? value : [value])
}

function normalizePriorities(
  value?: ObservationPriority | ObservationPriority[],
): Set<ObservationPriority> | undefined {
  if (!value) return undefined
  return new Set(Array.isArray(value) ? value : [value])
}

function buildObservationRecord(
  sessionId: string,
  input: NewObservationInput,
): Result<ObservationRecord> {
  const parsedSessionId = nonEmptyStringSchema.safeParse(sessionId)
  if (!parsedSessionId.success) {
    return err(formatZodIssues('Invalid session ID', parsedSessionId.error))
  }

  const parsedInput = newObservationSchema.safeParse(input)
  if (!parsedInput.success) {
    return err(formatZodIssues('Invalid observation input', parsedInput.error))
  }

  return ok({
    id: parsedInput.data.id ?? crypto.randomUUID(),
    sessionId: parsedSessionId.data,
    observedAt: parsedInput.data.observedAt ?? new Date().toISOString(),
    effectiveAt: parsedInput.data.effectiveAt,
    kind: parsedInput.data.kind,
    summary: parsedInput.data.summary,
    evidence: parsedInput.data.evidence,
    priority: parsedInput.data.priority,
    tags: parsedInput.data.tags,
    supersedes: parsedInput.data.supersedes,
  })
}

function ensureObservationDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function parseObservationLine(
  sessionId: string,
  line: string,
  lineNumber: number,
): Result<ObservationRecord> {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(line)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Invalid observation JSON on line ${lineNumber}: ${message}`))
  }

  const parsedRecord = observationRecordSchema.safeParse(parsedJson)
  if (!parsedRecord.success) {
    return err(
      formatZodIssues(`Invalid observation record on line ${lineNumber}`, parsedRecord.error),
    )
  }

  if (parsedRecord.data.sessionId !== sessionId) {
    return err(
      new Error(
        `Observation session mismatch on line ${lineNumber}: expected "${sessionId}" but found "${parsedRecord.data.sessionId}"`,
      ),
    )
  }

  return ok(parsedRecord.data)
}

function sortChronologically(
  records: Array<{ record: ObservationRecord; lineNumber: number }>,
): ObservationRecord[] {
  return [...records]
    .sort((left, right) => {
      const timeDiff = Date.parse(left.record.observedAt) - Date.parse(right.record.observedAt)
      if (timeDiff !== 0) {
        return timeDiff
      }
      return left.lineNumber - right.lineNumber
    })
    .map(({ record }) => record)
}

function validateFilterOptions(
  options?: ObservationFilterOptions,
): Result<ObservationFilterOptions> {
  if (!options) {
    return ok({})
  }

  if (options.since) {
    const parsedSince = timestampSchema.safeParse(options.since)
    if (!parsedSince.success) {
      return err(formatZodIssues('Invalid observation filter', parsedSince.error))
    }
  }

  if (options.until) {
    const parsedUntil = timestampSchema.safeParse(options.until)
    if (!parsedUntil.success) {
      return err(formatZodIssues('Invalid observation filter', parsedUntil.error))
    }
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    return err(new Error('Invalid observation filter: limit must be a non-negative integer'))
  }

  return ok(options)
}

export function appendObservationBatch(
  sessionId: string,
  inputs: NewObservationInput[],
  basePath?: string,
): Result<ObservationRecord[]> {
  try {
    const filePath = resolveObservationLogPath(sessionId, basePath)
    const records: ObservationRecord[] = []

    for (const input of inputs) {
      const recordResult = buildObservationRecord(sessionId, input)
      if (!recordResult.ok) {
        return recordResult
      }
      records.push(recordResult.value)
    }

    if (records.length === 0) {
      return ok([])
    }

    ensureObservationDir(filePath)
    const lines = records.map((record) => JSON.stringify(record)).join('\n')
    appendFileSync(filePath, `${lines}\n`, 'utf-8')
    return ok(records)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to append observations: ${message}`))
  }
}

export function appendObservation(
  sessionId: string,
  input: NewObservationInput,
  basePath?: string,
): Result<ObservationRecord> {
  const result = appendObservationBatch(sessionId, [input], basePath)
  if (!result.ok) {
    return result
  }
  return ok(result.value[0])
}

export function readObservations(
  sessionId: string,
  basePath?: string,
): Result<ObservationRecord[]> {
  try {
    const filePath = resolveObservationLogPath(sessionId, basePath)
    if (!existsSync(filePath)) {
      return ok([])
    }

    const content = readFileSync(filePath, 'utf-8')
    if (content.trim().length === 0) {
      return ok([])
    }

    const parsedRecords: Array<{ record: ObservationRecord; lineNumber: number }> = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index]?.trim()
      if (!rawLine) {
        continue
      }

      const parsedRecord = parseObservationLine(sessionId, rawLine, index + 1)
      if (!parsedRecord.ok) {
        return parsedRecord
      }

      parsedRecords.push({ record: parsedRecord.value, lineNumber: index + 1 })
    }

    return ok(sortChronologically(parsedRecords))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to read observations: ${message}`))
  }
}

export function filterObservations(
  sessionId: string,
  options?: ObservationFilterOptions,
  basePath?: string,
): Result<ObservationRecord[]> {
  const optionResult = validateFilterOptions(options)
  if (!optionResult.ok) {
    return optionResult
  }

  const readResult = readObservations(sessionId, basePath)
  if (!readResult.ok) {
    return readResult
  }

  const kinds = normalizeKinds(optionResult.value.kind)
  const priorities = normalizePriorities(optionResult.value.priority)
  const tags = optionResult.value.tags ? new Set(optionResult.value.tags) : undefined
  const sinceMs = optionResult.value.since ? Date.parse(optionResult.value.since) : undefined
  const untilMs = optionResult.value.until ? Date.parse(optionResult.value.until) : undefined

  let records = readResult.value.filter((record) => {
    if (kinds && !kinds.has(record.kind)) {
      return false
    }

    if (priorities && !priorities.has(record.priority)) {
      return false
    }

    if (tags && !record.tags.some((tag) => tags.has(tag))) {
      return false
    }

    if (
      optionResult.value.supersedes &&
      !(record.supersedes ?? []).includes(optionResult.value.supersedes)
    ) {
      return false
    }

    const observedAtMs = Date.parse(record.observedAt)
    if (sinceMs !== undefined && observedAtMs < sinceMs) {
      return false
    }

    if (untilMs !== undefined && observedAtMs > untilMs) {
      return false
    }

    return true
  })

  if (optionResult.value.limit !== undefined) {
    records = records.slice(0, optionResult.value.limit)
  }

  return ok(records)
}

export function getRecentObservations(
  sessionId: string,
  limit: number,
  basePath?: string,
): Result<ObservationRecord[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    return err(
      new Error('Invalid recent observation request: limit must be a non-negative integer'),
    )
  }

  const readResult = readObservations(sessionId, basePath)
  if (!readResult.ok) {
    return readResult
  }

  if (limit === 0) {
    return ok([])
  }

  return ok(readResult.value.slice(-limit))
}
