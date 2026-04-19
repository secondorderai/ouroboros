import { describe, test, expect } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { name, description, schema, execute } from '@src/tools/crystallize'
import { createRegistry } from '@src/tools/registry'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

describe('CrystallizeTool', () => {
  test('exports correct tool interface', () => {
    expect(name).toBe('crystallize')
    expect(typeof description).toBe('string')
    expect(description).toContain('crystallization pipeline')
    expect(schema.safeParse({ taskSummary: 'Finished a task' }).success).toBe(true)
    expect(
      schema.safeParse({ taskSummary: 'Finished a task', transcript: 'details', autoCommit: false })
        .success,
    ).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
  })

  test('tool is registered in the built-in registry', async () => {
    const registry = await createRegistry()
    const tool = registry.getTool('crystallize')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('crystallize')
  })

  test('execute returns a Result error when config is invalid', async () => {
    const tempDir = makeTempDir('ouroboros-crystallize-tool')
    const originalCwd = process.cwd()
    writeFileSync(
      `${tempDir}/.ouroboros`,
      JSON.stringify({ model: { provider: 'unsupported-provider', name: 'mock-model' } }),
    )
    process.chdir(tempDir)
    try {
      const result = await execute({
        taskSummary: 'Task that cannot reach an LLM',
        autoCommit: false,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('Failed to load config')
    } finally {
      process.chdir(originalCwd)
      cleanupTempDir(tempDir)
    }
  })
})
