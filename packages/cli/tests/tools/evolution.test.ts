import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { name, description, schema, createExecute } from '@src/tools/evolution'
import { appendEntry } from '@src/rsi/evolution-log'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

describe('EvolutionTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-evolution-tool')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('evolution')
    expect(typeof description).toBe('string')
    expect(description).toContain('evolution log')
    expect(schema.safeParse({ action: 'log' }).success).toBe(true)
    expect(schema.safeParse({ action: 'stats' }).success).toBe(true)
    expect(schema.safeParse({ action: 'search', type: 'skill-created' }).success).toBe(true)
    expect(schema.safeParse({ action: 'delete' }).success).toBe(false)
  })

  test('log action returns recent entries with skill names', async () => {
    appendEntry(
      {
        type: 'skill-created',
        summary: 'Created fixture skill',
        details: { skillName: 'fixture-skill' },
        motivation: 'Regression test setup',
      },
      tempDir,
    )
    const runEvolution = createExecute({ basePath: tempDir })

    const result = await runEvolution({ action: 'log', limit: 5 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain('skill-created')
    expect(result.value).toContain('Created fixture skill')
    expect(result.value).toContain('fixture-skill')
  })

  test('stats action returns aggregate counts', async () => {
    appendEntry(
      {
        type: 'skill-created',
        summary: 'Created first skill',
        details: { skillName: 'first-skill' },
        motivation: 'Regression test setup',
      },
      tempDir,
    )
    appendEntry(
      {
        type: 'skill-failed',
        summary: 'Rejected broken skill',
        details: { skillName: 'broken-skill' },
        motivation: 'Regression test setup',
      },
      tempDir,
    )
    const runEvolution = createExecute({ basePath: tempDir })

    const result = await runEvolution({ action: 'stats' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain('Total entries: 2')
    expect(result.value).toContain('Skills created: 1')
    expect(result.value).toContain('Skills failed: 1')
  })

  test('search action returns a friendly empty state', async () => {
    const runEvolution = createExecute({ basePath: tempDir })

    const result = await runEvolution({ action: 'search', type: 'memory-updated', limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('No matching evolution entries found.')
  })
})
