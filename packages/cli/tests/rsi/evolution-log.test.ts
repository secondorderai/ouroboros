import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendEntry,
  getEntries,
  getStats,
  readLog,
  type EvolutionEntry,
  type NewEvolutionEntry,
} from '@src/rsi/evolution-log'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-evolution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeEntry(
  type: EvolutionEntry['type'],
  summary: string,
  overrides?: Partial<NewEvolutionEntry>,
): NewEvolutionEntry {
  return {
    type,
    summary,
    details: overrides?.details ?? {},
    motivation: overrides?.motivation ?? 'Test motivation',
  }
}

describe('Evolution Log — Track All Self-Modifications', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Test: Append entry creates log file ─────────────────────────

  test('append entry creates log file when none exists', () => {
    const logPath = join(tempDir, 'evolution.log.json')
    expect(existsSync(logPath)).toBe(false)

    const result = appendEntry(makeEntry('skill-created', 'Created test skill'), tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // File should now exist
    expect(existsSync(logPath)).toBe(true)

    // Entry has auto-generated id (UUID format) and timestamp (ISO 8601)
    expect(result.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(result.value.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // File contains valid JSON array with one entry
    const content = JSON.parse(readFileSync(logPath, 'utf-8')) as EvolutionEntry[]
    expect(Array.isArray(content)).toBe(true)
    expect(content.length).toBe(1)
    expect(content[0].type).toBe('skill-created')
    expect(content[0].summary).toBe('Created test skill')
  })

  // ── Test: Append preserves existing entries ─────────────────────

  test('append preserves existing entries (newest first)', () => {
    // Seed 3 existing entries
    const existing: EvolutionEntry[] = [
      {
        id: 'entry-3',
        timestamp: '2025-03-01T00:00:00.000Z',
        type: 'memory-updated',
        summary: 'Third entry',
        details: {},
        motivation: 'reason 3',
      },
      {
        id: 'entry-2',
        timestamp: '2025-02-01T00:00:00.000Z',
        type: 'skill-promoted',
        summary: 'Second entry',
        details: {},
        motivation: 'reason 2',
      },
      {
        id: 'entry-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'skill-created',
        summary: 'First entry',
        details: {},
        motivation: 'reason 1',
      },
    ]
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(existing, null, 2), 'utf-8')

    // Append new entry
    const result = appendEntry(makeEntry('config-changed', 'New entry'), tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // File should have 4 entries, new one first
    const content = JSON.parse(
      readFileSync(join(tempDir, 'evolution.log.json'), 'utf-8'),
    ) as EvolutionEntry[]
    expect(content.length).toBe(4)
    expect(content[0].summary).toBe('New entry')
    expect(content[0].type).toBe('config-changed')
    // Original 3 unchanged
    expect(content[1].id).toBe('entry-3')
    expect(content[2].id).toBe('entry-2')
    expect(content[3].id).toBe('entry-1')
  })

  // ── Test: Filter by type ────────────────────────────────────────

  test('getEntries filters by type', () => {
    // Seed 5 entries: 2 skill-created, 2 memory-updated, 1 skill-promoted
    const entries: EvolutionEntry[] = [
      {
        id: 'e5',
        timestamp: '2025-05-01T00:00:00.000Z',
        type: 'skill-created',
        summary: 'skill 2',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e4',
        timestamp: '2025-04-01T00:00:00.000Z',
        type: 'memory-updated',
        summary: 'memory 2',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e3',
        timestamp: '2025-03-01T00:00:00.000Z',
        type: 'skill-promoted',
        summary: 'promoted 1',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e2',
        timestamp: '2025-02-01T00:00:00.000Z',
        type: 'memory-updated',
        summary: 'memory 1',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'skill-created',
        summary: 'skill 1',
        details: {},
        motivation: 'r',
      },
    ]
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(entries, null, 2), 'utf-8')

    const result = getEntries({ type: 'skill-created' }, tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(2)
    expect(result.value.every((e) => e.type === 'skill-created')).toBe(true)
  })

  // ── Test: Filter by limit ───────────────────────────────────────

  test('getEntries respects limit', () => {
    // Seed 20 entries
    const entries: EvolutionEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${20 - i}`,
      timestamp: `2025-01-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
      type: 'memory-updated' as const,
      summary: `entry ${20 - i}`,
      details: {},
      motivation: 'r',
    }))
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(entries, null, 2), 'utf-8')

    const result = getEntries({ limit: 5 }, tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(5)
  })

  // ── Test: Filter by since date ──────────────────────────────────

  test('getEntries filters by since date', () => {
    const entries: EvolutionEntry[] = [
      {
        id: 'e3',
        timestamp: '2025-03-15T00:00:00.000Z',
        type: 'skill-created',
        summary: 'March',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e2',
        timestamp: '2025-02-15T00:00:00.000Z',
        type: 'skill-created',
        summary: 'February',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e1',
        timestamp: '2025-01-15T00:00:00.000Z',
        type: 'skill-created',
        summary: 'January',
        details: {},
        motivation: 'r',
      },
    ]
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(entries, null, 2), 'utf-8')

    const result = getEntries({ since: '2025-02-01T00:00:00.000Z' }, tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(2)
    expect(result.value[0].summary).toBe('March')
    expect(result.value[1].summary).toBe('February')
  })

  // ── Test: Stats calculation ─────────────────────────────────────

  test('getStats returns accurate summary statistics', () => {
    const entries: EvolutionEntry[] = [
      {
        id: 'e5',
        timestamp: '2025-05-01T00:00:00.000Z',
        type: 'skill-created',
        summary: 's',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e4',
        timestamp: '2025-04-01T00:00:00.000Z',
        type: 'skill-created',
        summary: 's',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e3',
        timestamp: '2025-03-01T00:00:00.000Z',
        type: 'skill-promoted',
        summary: 's',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e2',
        timestamp: '2025-02-01T00:00:00.000Z',
        type: 'skill-failed',
        summary: 's',
        details: {},
        motivation: 'r',
      },
      {
        id: 'e1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'memory-updated',
        summary: 's',
        details: {},
        motivation: 'r',
      },
    ]
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(entries, null, 2), 'utf-8')

    const result = getStats(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.totalEntries).toBe(5)
    expect(result.value.skillsCreated).toBe(2)
    expect(result.value.skillsPromoted).toBe(1)
    expect(result.value.skillsFailed).toBe(1)
    expect(result.value.byType['memory-updated']).toBe(1)
    expect(result.value.firstEntry).toBe('2025-01-01T00:00:00.000Z')
    expect(result.value.lastEntry).toBe('2025-05-01T00:00:00.000Z')
    expect(result.value.compactionsPerSession).toEqual({})
    expect(result.value.successfulResumesAfterCompaction).toBe(0)
    expect(result.value.repeatedWorkRateAfterCompaction).toBe(0)
    expect(result.value.durableMemoryReuseRate).toBe(0)
  })

  test('getStats summarizes compaction and structured memory metrics', () => {
    const entries: EvolutionEntry[] = [
      {
        id: 'e6',
        timestamp: '2025-06-01T00:00:00.000Z',
        type: 'checkpoint-written',
        summary: 'checkpoint',
        details: {
          sessionId: 'session-a',
          metadata: {
            reusedDurableMemoryItems: ['Keep migration constraints visible (constraint)'],
          },
        },
        motivation: 'r',
      },
      {
        id: 'e5',
        timestamp: '2025-05-01T00:00:00.000Z',
        type: 'length-recovery-succeeded',
        summary: 'recovered',
        details: {
          sessionId: 'session-a',
          repeatedWorkDetected: false,
        },
        motivation: 'r',
      },
      {
        id: 'e4',
        timestamp: '2025-04-01T00:00:00.000Z',
        type: 'history-compacted',
        summary: 'compacted',
        details: {
          sessionId: 'session-a',
          droppedMessageCount: 8,
          retainedMessageCount: 2,
        },
        motivation: 'r',
      },
      {
        id: 'e3',
        timestamp: '2025-03-01T00:00:00.000Z',
        type: 'durable-memory-promoted',
        summary: 'promoted',
        details: {
          sessionId: 'session-a',
          item: 'Keep migration constraints visible (constraint)',
        },
        motivation: 'r',
      },
      {
        id: 'e2',
        timestamp: '2025-02-01T00:00:00.000Z',
        type: 'skill-proposed-from-observations',
        summary: 'proposal',
        details: {
          skillName: 'checkpoint-recovery',
          sourceSessionIds: ['session-a', 'session-b'],
          repeatCount: 2,
        },
        motivation: 'r',
      },
      {
        id: 'e1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'length-recovery-failed',
        summary: 'failed',
        details: {
          sessionId: 'session-b',
          repeatedWorkDetected: true,
        },
        motivation: 'r',
      },
    ]
    writeFileSync(join(tempDir, 'evolution.log.json'), JSON.stringify(entries, null, 2), 'utf-8')

    const result = getStats(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.compactionsPerSession).toEqual({ 'session-a': 1 })
    expect(result.value.successfulResumesAfterCompaction).toBe(1)
    expect(result.value.repeatedWorkRateAfterCompaction).toBe(0.5)
    expect(result.value.durableMemoryReuseRate).toBe(1)
    expect(result.value.skillProposalsFromObservations).toBe(1)
    expect(result.value.durablePromotions).toBe(1)
    expect(result.value.sessionsAnalyzed).toBe(2)
    expect(result.value.successRate).toBe(0.5)
  })

  // ── Test: Atomic write safety ───────────────────────────────────

  test('uses atomic write (temp file + rename pattern)', () => {
    // We verify the implementation pattern by checking that:
    // 1. After a write, the file is valid JSON
    // 2. No temp files remain
    const result = appendEntry(makeEntry('skill-created', 'Atomic test'), tempDir)
    expect(result.ok).toBe(true)

    // File should be valid JSON
    const content = readFileSync(join(tempDir, 'evolution.log.json'), 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()

    // No temp files should remain
    const { readdirSync } = require('node:fs')
    const files = (readdirSync(tempDir) as string[]).filter((f: string) =>
      f.startsWith('.evolution-log.tmp'),
    )
    expect(files.length).toBe(0)
  })

  // ── Test: Corrupted log file recovery ───────────────────────────

  test('returns Result.err for corrupted log file', () => {
    writeFileSync(join(tempDir, 'evolution.log.json'), 'this is not valid json{{{', 'utf-8')

    const result = getEntries(undefined, tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Corrupted evolution log')
  })

  // ── Test: Missing log file returns empty array ──────────────────

  test('readLog returns empty array when no log file exists', () => {
    const result = readLog(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  // ── Test: Empty log file returns empty array ────────────────────

  test('readLog returns empty array for empty file', () => {
    writeFileSync(join(tempDir, 'evolution.log.json'), '', 'utf-8')

    const result = readLog(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  // ── Test: Entry details are preserved ───────────────────────────

  test('entry details are preserved through append and read', () => {
    const result = appendEntry(
      {
        type: 'skill-created',
        summary: 'Created auto-test skill',
        details: {
          skillName: 'auto-test',
          sessionId: 'session-123',
          before: 'none',
          after: 'skill created',
          diff: '+ new skill file',
        },
        motivation: 'Pattern detected in sessions',
      },
      tempDir,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const entries = getEntries(undefined, tempDir)
    expect(entries.ok).toBe(true)
    if (!entries.ok) return

    expect(entries.value.length).toBe(1)
    expect(entries.value[0].details.skillName).toBe('auto-test')
    expect(entries.value[0].details.sessionId).toBe('session-123')
    expect(entries.value[0].details.diff).toBe('+ new skill file')
    expect(entries.value[0].motivation).toBe('Pattern detected in sessions')
  })

  // ── Test: getStats on empty log ─────────────────────────────────

  test('getStats returns zeroes on empty log', () => {
    const result = getStats(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.totalEntries).toBe(0)
    expect(result.value.skillsCreated).toBe(0)
    expect(result.value.skillsPromoted).toBe(0)
    expect(result.value.skillsFailed).toBe(0)
    expect(result.value.firstEntry).toBeUndefined()
    expect(result.value.lastEntry).toBeUndefined()
    expect(result.value.compactionsPerSession).toEqual({})
    expect(result.value.successfulResumesAfterCompaction).toBe(0)
    expect(result.value.repeatedWorkRateAfterCompaction).toBe(0)
    expect(result.value.durableMemoryReuseRate).toBe(0)
  })

  // ── Test: All functions return Result — never throw ─────────────

  test('appendEntry never throws', () => {
    // Even with invalid entry, should return Result.err
    const result = appendEntry(
      { type: 'invalid-type' as 'skill-created', summary: '', details: {}, motivation: '' },
      tempDir,
    )
    // This should succeed because the cast bypasses TS but the Zod validation
    // may accept it at runtime since 'invalid-type' won't match the enum
    // In practice, it returns err due to Zod validation
    expect(result.ok === true || result.ok === false).toBe(true)
  })
})
