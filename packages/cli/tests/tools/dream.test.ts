import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { name, description, schema, createExecute, execute } from '@src/tools/dream'
import { err, ok } from '@src/types'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

describe('DreamTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-dream-tool')
    mkdirSync(`${tempDir}/memory`, { recursive: true })
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('dream')
    expect(typeof description).toBe('string')
    expect(description).toContain('dream cycle')
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ sessionCount: 2, mode: 'consolidate-only' }).success).toBe(true)
    expect(schema.safeParse({ mode: 'invalid' }).success).toBe(false)
  })

  test('default execute returns dependency configuration error', async () => {
    const result = await execute({ sessionCount: 1, mode: 'full' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires dependencies')
  })

  test('createExecute runs dream cycle with injected dependencies', async () => {
    const calls: number[] = []
    const runDream = createExecute({
      dreamDeps: {
        basePath: tempDir,
        generateFn: async () => ok('{}'),
        getRecentSessions: (limit) => {
          calls.push(limit)
          return ok([])
        },
        getSession: () => err(new Error('getSession should not be called with no sessions')),
      },
    })

    const result = await runDream({ sessionCount: 3, mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    expect(calls).toEqual([3])
    if (!result.ok) return
    expect(result.value.sessionsAnalyzed).toBe(0)
    expect(result.value.skillProposals).toEqual([])
    expect(result.value.memoryIndexUpdated).toBe(false)
  })

  test('createExecute returns dependency errors instead of throwing', async () => {
    const runDream = createExecute({
      dreamDeps: {
        basePath: tempDir,
        generateFn: async () => ok('{}'),
        getRecentSessions: () => err(new Error('transcript store unavailable')),
        getSession: () => err(new Error('unused')),
      },
    })

    const result = await runDream({ sessionCount: 1, mode: 'full' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('transcript store unavailable')
  })
})
