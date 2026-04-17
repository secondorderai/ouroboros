import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendObservation,
  appendObservationBatch,
  filterObservations,
  getRecentObservations,
  readObservations,
} from '@src/memory/observations'
import { resolveObservationLogPath } from '@src/memory/paths'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-observations-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Layer 2 — Observation Log', () => {
  let tempDir: string
  const sessionId = 'session-observe-1'

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('observation append and replay returns records in chronological order', () => {
    const batchResult = appendObservationBatch(
      sessionId,
      [
        {
          id: 'progress-2',
          observedAt: '2026-04-15T00:00:02.000Z',
          kind: 'progress',
          summary: 'Second progress update',
          evidence: ['completed parser'],
          priority: 'normal',
          tags: ['memory', 'phase-1'],
        },
        {
          id: 'goal-1',
          observedAt: '2026-04-15T00:00:01.000Z',
          kind: 'goal',
          summary: 'Implement observation log storage',
          evidence: ['ticket-02'],
          priority: 'high',
          tags: ['memory', 'phase-1'],
        },
      ],
      tempDir,
    )

    expect(batchResult.ok).toBe(true)
    if (!batchResult.ok) return

    const logPath = resolveObservationLogPath(sessionId, tempDir)
    expect(existsSync(logPath)).toBe(true)

    const readResult = readObservations(sessionId, tempDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return

    expect(readResult.value.map((record) => record.id)).toEqual(['goal-1', 'progress-2'])
    expect(readResult.value[0]?.summary).toBe('Implement observation log storage')
    expect(readResult.value[1]?.evidence).toEqual(['completed parser'])
  })

  test('supersession metadata persists across append and read', () => {
    const originalResult = appendObservation(
      sessionId,
      {
        id: 'constraint-1',
        observedAt: '2026-04-15T00:00:01.000Z',
        effectiveAt: '2026-04-15T00:00:01.000Z',
        kind: 'constraint',
        summary: 'Keep observation storage append-only',
        evidence: ['ticket requirement'],
        priority: 'high',
        tags: ['constraint'],
      },
      tempDir,
    )
    expect(originalResult.ok).toBe(true)
    if (!originalResult.ok) return

    const replacementResult = appendObservation(
      sessionId,
      {
        id: 'constraint-2',
        observedAt: '2026-04-15T00:00:02.000Z',
        effectiveAt: '2026-04-15T00:00:02.000Z',
        kind: 'constraint',
        summary: 'Keep observation storage append-only and JSONL-backed',
        evidence: ['refined requirement'],
        priority: 'critical',
        tags: ['constraint', 'jsonl'],
        supersedes: [originalResult.value.id],
      },
      tempDir,
    )
    expect(replacementResult.ok).toBe(true)
    if (!replacementResult.ok) return

    const readResult = readObservations(sessionId, tempDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return

    expect(readResult.value).toHaveLength(2)
    expect(readResult.value[1]?.supersedes).toEqual(['constraint-1'])
    expect(readResult.value[1]?.effectiveAt).toBe('2026-04-15T00:00:02.000Z')
  })

  test('invalid observation input is rejected cleanly without writing a file', () => {
    const appendResult = appendObservation(
      sessionId,
      {
        kind: 'fact',
        summary: '',
        evidence: ['missing summary should fail'],
        priority: 'normal',
        tags: ['invalid'],
      },
      tempDir,
    )

    expect(appendResult.ok).toBe(false)
    if (appendResult.ok) return

    expect(appendResult.error.message).toContain('Invalid observation input')
    expect(existsSync(resolveObservationLogPath(sessionId, tempDir))).toBe(false)
  })

  test('filter and recent helpers return narrowed chronological batches', () => {
    const appendResult = appendObservationBatch(
      sessionId,
      [
        {
          id: 'goal-1',
          observedAt: '2026-04-15T00:00:01.000Z',
          kind: 'goal',
          summary: 'Finish observation API',
          evidence: ['ticket-02'],
          priority: 'high',
          tags: ['memory', 'rsi'],
        },
        {
          id: 'warning-1',
          observedAt: '2026-04-15T00:00:02.000Z',
          kind: 'warning',
          summary: 'Malformed JSONL should stop reads',
          evidence: ['reader requirement'],
          priority: 'critical',
          tags: ['memory', 'validation'],
        },
        {
          id: 'progress-1',
          observedAt: '2026-04-15T00:00:03.000Z',
          kind: 'progress',
          summary: 'Unit tests added',
          evidence: ['observations.test.ts'],
          priority: 'normal',
          tags: ['memory', 'tests'],
        },
      ],
      tempDir,
    )
    expect(appendResult.ok).toBe(true)
    if (!appendResult.ok) return

    const filteredResult = filterObservations(
      sessionId,
      { kind: ['goal', 'warning'], tags: ['validation'], since: '2026-04-15T00:00:01.500Z' },
      tempDir,
    )
    expect(filteredResult.ok).toBe(true)
    if (!filteredResult.ok) return

    expect(filteredResult.value.map((record) => record.id)).toEqual(['warning-1'])

    const recentResult = getRecentObservations(sessionId, 2, tempDir)
    expect(recentResult.ok).toBe(true)
    if (!recentResult.ok) return

    expect(recentResult.value.map((record) => record.id)).toEqual(['warning-1', 'progress-1'])
  })

  test('invalid JSONL content is rejected with a line-numbered parse error', () => {
    const logPath = resolveObservationLogPath(sessionId, tempDir)
    mkdirSync(join(tempDir, 'memory', 'observations'), { recursive: true })
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          id: 'goal-1',
          sessionId,
          observedAt: '2026-04-15T00:00:01.000Z',
          kind: 'goal',
          summary: 'Good record',
          evidence: ['seed'],
          priority: 'high',
          tags: ['memory'],
        }),
        '{"id":"broken"',
      ].join('\n'),
      'utf-8',
    )

    const readResult = readObservations(sessionId, tempDir)
    expect(readResult.ok).toBe(false)
    if (readResult.ok) return

    expect(readResult.error.message).toContain('Invalid observation JSON on line 2')
  })
})
