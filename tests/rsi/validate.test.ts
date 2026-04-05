import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSkillTests, discoverTestFiles } from '@src/rsi/validate'

// ── Helpers ──────────────────────────────────────────────────────────

let tempDir: string

function createTempDir(): string {
  const dir = join(tmpdir(), `ouroboros-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function createSkillDir(opts: {
  skillName?: string
  withSkillMd?: boolean
  scripts?: Record<string, string>
}): string {
  const skillName = opts.skillName ?? 'test-skill'
  const skillDir = join(tempDir, skillName)
  mkdirSync(skillDir, { recursive: true })

  if (opts.withSkillMd !== false) {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: A test skill
---

# ${skillName}

Test skill for validation.
`,
    )
  }

  if (opts.scripts) {
    const scriptsDir = join(skillDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    for (const [filename, content] of Object.entries(opts.scripts)) {
      writeFileSync(join(scriptsDir, filename), content)
    }
  }

  return skillDir
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  tempDir = createTempDir()
})

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup
  }
})

// ── Feature Tests ────────────────────────────────────────────────────

describe('runSkillTests', () => {
  // -----------------------------------------------------------------------
  // Feature test: Passing TypeScript test
  // -----------------------------------------------------------------------
  test('passing TypeScript test', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.ts': `
import { describe, test, expect } from 'bun:test'

describe('math', () => {
  test('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2)
  })
})
`,
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overall).toBe('pass')
      expect(result.value.testFiles).toHaveLength(1)
      expect(result.value.testFiles[0].file).toBe('test.ts')
      expect(result.value.testFiles[0].status).toBe('pass')
      expect(result.value.testFiles[0].exitCode).toBe(0)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Failing TypeScript test
  // -----------------------------------------------------------------------
  test('failing TypeScript test', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.ts': `
import { describe, test, expect } from 'bun:test'

describe('math', () => {
  test('1 + 1 === 3', () => {
    expect(1 + 1).toBe(3)
  })
})
`,
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overall).toBe('fail')
      expect(result.value.testFiles).toHaveLength(1)
      expect(result.value.testFiles[0].file).toBe('test.ts')
      expect(result.value.testFiles[0].status).toBe('fail')
      expect(result.value.testFiles[0].exitCode).not.toBe(0)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Mixed results (multiple test files)
  // -----------------------------------------------------------------------
  test('mixed results with multiple test files', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.ts': `
import { describe, test, expect } from 'bun:test'

describe('pass', () => {
  test('passes', () => {
    expect(true).toBe(true)
  })
})
`,
        'test.sh': '#!/bin/bash\nexit 1\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overall).toBe('fail')
      expect(result.value.testFiles).toHaveLength(2)

      const tsResult = result.value.testFiles.find((f) => f.file === 'test.ts')
      const shResult = result.value.testFiles.find((f) => f.file === 'test.sh')

      expect(tsResult).toBeDefined()
      expect(tsResult!.status).toBe('pass')

      expect(shResult).toBeDefined()
      expect(shResult!.status).toBe('fail')
      expect(shResult!.exitCode).toBe(1)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Timeout enforcement
  // -----------------------------------------------------------------------
  test(
    'timeout enforcement',
    async () => {
      const skillDir = createSkillDir({
        scripts: {
          'test.sh': '#!/bin/bash\nsleep 60\n',
        },
      })

      const start = Date.now()
      const result = await runSkillTests(skillDir)
      const elapsed = Date.now() - start

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.overall).toBe('fail')
        expect(result.value.testFiles).toHaveLength(1)
        expect(result.value.testFiles[0].status).toBe('error')
        expect(result.value.testFiles[0].stderr).toContain('timed out')
      }

      // Should have taken roughly 30s, not 60s. Allow some slack.
      expect(elapsed).toBeLessThan(45_000)
    },
    { timeout: 60_000 },
  )

  // -----------------------------------------------------------------------
  // Feature test: No test files found
  // -----------------------------------------------------------------------
  test('no test files found', async () => {
    const skillDir = createSkillDir({
      scripts: {},
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('No test files found')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Missing skill directory
  // -----------------------------------------------------------------------
  test('missing skill directory', async () => {
    const result = await runSkillTests(join(tempDir, 'nonexistent-skill'))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('does not exist')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Missing SKILL.md
  // -----------------------------------------------------------------------
  test('missing SKILL.md', async () => {
    const skillDir = createSkillDir({ withSkillMd: false })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('missing SKILL.md')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Python test execution
  // -----------------------------------------------------------------------
  test('python test execution', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.py': 'assert 1 + 1 == 2\nprint("ok")\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overall).toBe('pass')
      expect(result.value.testFiles).toHaveLength(1)
      expect(result.value.testFiles[0].file).toBe('test.py')
      expect(result.value.testFiles[0].status).toBe('pass')
      expect(result.value.testFiles[0].exitCode).toBe(0)
      expect(result.value.testFiles[0].stdout).toContain('ok')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Shell test execution (passing)
  // -----------------------------------------------------------------------
  test('passing shell test', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.sh': '#!/bin/bash\necho "all good"\nexit 0\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overall).toBe('pass')
      expect(result.value.testFiles).toHaveLength(1)
      expect(result.value.testFiles[0].status).toBe('pass')
      expect(result.value.testFiles[0].stdout).toContain('all good')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Glob-style test file names (*.test.ts)
  // -----------------------------------------------------------------------
  test('discovers glob-style test file names', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'math.test.ts': `
import { describe, test, expect } from 'bun:test'

describe('math', () => {
  test('works', () => {
    expect(2 + 2).toBe(4)
  })
})
`,
        'utils.test.sh': '#!/bin/bash\nexit 0\n',
        'not-a-test.ts': 'console.log("helper")\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.testFiles).toHaveLength(2)
      const files = result.value.testFiles.map((f) => f.file)
      expect(files).toContain('math.test.ts')
      expect(files).toContain('utils.test.sh')
      expect(files).not.toContain('not-a-test.ts')
    }
  })

  // -----------------------------------------------------------------------
  // Result structure validation
  // -----------------------------------------------------------------------
  test('result contains skillName and skillPath', async () => {
    const skillDir = createSkillDir({
      skillName: 'my-awesome-skill',
      scripts: {
        'test.sh': '#!/bin/bash\nexit 0\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.skillName).toBe('my-awesome-skill')
      expect(result.value.skillPath).toBe(skillDir)
    }
  })

  // -----------------------------------------------------------------------
  // Duration tracking
  // -----------------------------------------------------------------------
  test('tracks duration for each test file', async () => {
    const skillDir = createSkillDir({
      scripts: {
        'test.sh': '#!/bin/bash\nsleep 0.1\nexit 0\n',
      },
    })

    const result = await runSkillTests(skillDir)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.testFiles[0].durationMs).toBeGreaterThan(0)
    }
  })
})

// ── discoverTestFiles tests ──────────────────────────────────────────

describe('discoverTestFiles', () => {
  test('discovers exact test file names', async () => {
    const scriptsDir = join(tempDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'test.ts'), '')
    writeFileSync(join(scriptsDir, 'test.py'), '')
    writeFileSync(join(scriptsDir, 'test.sh'), '')
    writeFileSync(join(scriptsDir, 'helper.ts'), '')

    const files = await discoverTestFiles(scriptsDir)

    expect(files).toEqual(['test.py', 'test.sh', 'test.ts'])
  })

  test('discovers suffix-pattern test files', async () => {
    const scriptsDir = join(tempDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'math.test.ts'), '')
    writeFileSync(join(scriptsDir, 'integration.test.py'), '')
    writeFileSync(join(scriptsDir, 'smoke.test.sh'), '')

    const files = await discoverTestFiles(scriptsDir)

    expect(files).toEqual(['integration.test.py', 'math.test.ts', 'smoke.test.sh'])
  })

  test('returns empty array for non-existent directory', async () => {
    const files = await discoverTestFiles(join(tempDir, 'nonexistent'))
    expect(files).toEqual([])
  })

  test('returns empty array when no test files match', async () => {
    const scriptsDir = join(tempDir, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'helper.ts'), '')
    writeFileSync(join(scriptsDir, 'setup.sh'), '')

    const files = await discoverTestFiles(scriptsDir)
    expect(files).toEqual([])
  })
})
