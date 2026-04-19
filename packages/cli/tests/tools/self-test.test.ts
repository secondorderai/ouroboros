import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { name, description, schema, execute } from '@src/tools/self-test'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

describe('SelfTestTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-self-test-tool')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('self-test')
    expect(typeof description).toBe('string')
    expect(description).toContain('test scripts')
    expect(schema.safeParse({ skillPath: '/tmp/example-skill' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
  })

  test('execute returns structured pass result for a passing skill test', async () => {
    const skillDir = join(tempDir, 'passing-skill')
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: passing-skill
description: A passing test skill
---

# Passing Skill
`,
    )
    writeFileSync(
      join(skillDir, 'scripts', 'test.ts'),
      `import { describe, test, expect } from 'bun:test'

describe('passing skill', () => {
  test('passes', () => {
    expect(1 + 1).toBe(2)
  })
})
`,
    )

    const result = await execute({ skillPath: skillDir })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skillName).toBe('passing-skill')
    expect(result.value.overall).toBe('pass')
    expect(result.value.testFiles).toHaveLength(1)
  })

  test('execute returns validation error for a missing skill path', async () => {
    const result = await execute({ skillPath: join(tempDir, 'missing-skill') })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('does not exist')
  })
})
