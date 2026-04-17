import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  formatDailyMemoryDate,
  resolveCheckpointPath,
  resolveDailyMemoryPath,
  resolveObservationLogPath,
} from '@src/memory/paths'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-memory-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Memory path helpers', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('resolves observation, checkpoint, and daily memory paths under memory/', () => {
    const sessionId = 'session-123'
    const date = '2026-04-15'

    expect(resolveObservationLogPath(sessionId, tempDir)).toBe(
      join(tempDir, 'memory', 'observations', 'session-123.jsonl'),
    )
    expect(resolveCheckpointPath(sessionId, tempDir)).toBe(
      join(tempDir, 'memory', 'checkpoints', 'session-123.md'),
    )
    expect(resolveDailyMemoryPath(date, tempDir)).toBe(
      join(tempDir, 'memory', 'daily', '2026-04-15.md'),
    )
  })

  test('formats Date inputs as YYYY-MM-DD for daily memory files', () => {
    const date = new Date(2026, 3, 15)

    expect(formatDailyMemoryDate(date)).toBe('2026-04-15')
    expect(resolveDailyMemoryPath(date, tempDir)).toBe(
      join(tempDir, 'memory', 'daily', '2026-04-15.md'),
    )
  })
})
