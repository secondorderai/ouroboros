/**
 * Tests for the Skill Crystallization Pipeline
 *
 * Covers the full 5-stage pipeline: Reflect -> Generate -> Validate -> Test -> Promote
 * Uses mocked LLM calls (via bun:test mock) to control pipeline behavior.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  crystallize,
  shouldCrystallize,
  writeSkillToStaging,
  validateSkillName,
  validateFrontmatter,
  validateRoundTrip,
  checkNameUniqueness,
  parseSkillResponse,
  buildGenerationPrompt,
  type ReflectionRecord,
  type GeneratedSkill,
} from '@src/rsi/crystallize'

// ── Test helpers ─────────────��────────────────────────────────────────

function makeTempDir(prefix = 'crystallize-test'): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Build a standard reflection record for testing. */
function makeReflection(overrides?: Partial<ReflectionRecord>): ReflectionRecord {
  return {
    taskSummary: 'Implemented a data pipeline with retry logic',
    novelty: 0.85,
    skillName: 'retry-pipeline',
    skillDescription: 'Build data pipelines with automatic retry and exponential backoff',
    keyInsights: ['Exponential backoff works well for rate-limited APIs', 'Circuit breakers help'],
    suggestedApproach: 'Use a pipeline builder pattern with configurable retry strategies',
    ...overrides,
  }
}

/** Build a standard generated skill for testing. */
function makeSkill(overrides?: Partial<GeneratedSkill>): GeneratedSkill {
  return {
    frontmatter: {
      name: 'retry-pipeline',
      description: 'Build data pipelines with automatic retry and exponential backoff',
    },
    body: '# Retry Pipeline\n\nInstructions for building retry pipelines.\n\n## Usage\n\nUse the pipeline builder pattern.',
    testScript: 'console.log("test passed"); process.exit(0);',
    ...overrides,
  }
}

/** Create skill dirs in a temp directory. */
function makeSkillDirs(baseDir: string) {
  const staging = join(baseDir, 'skills', 'staging')
  const generated = join(baseDir, 'skills', 'generated')
  const core = join(baseDir, 'skills', 'core')
  mkdirSync(staging, { recursive: true })
  mkdirSync(generated, { recursive: true })
  mkdirSync(core, { recursive: true })
  return { staging, generated, core }
}

// ── Mock setup for ai module ──────────���───────────────────────────────

// We mock the `generateText` function from the `ai` package.
// The pipeline calls it through reflect() and generateSkill().
const mockGenerateText = mock(() =>
  Promise.resolve({
    text: '{}',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: 'stop',
  }),
)

// Apply the mock
mock.module('ai', () => ({
  generateText: mockGenerateText,
}))

// Dummy LanguageModel — not actually called since generateText is mocked
const dummyLlm = {} as import('ai').LanguageModel

// ── Unit tests ──────────────────���────────────────────────────��────────

describe('shouldCrystallize', () => {
  test('returns true when novelty >= threshold', () => {
    expect(shouldCrystallize(makeReflection({ novelty: 0.85 }), 0.7)).toBe(true)
  })

  test('returns true when novelty equals threshold exactly', () => {
    expect(shouldCrystallize(makeReflection({ novelty: 0.7 }), 0.7)).toBe(true)
  })

  test('returns false when novelty < threshold', () => {
    expect(shouldCrystallize(makeReflection({ novelty: 0.2 }), 0.7)).toBe(false)
  })
})

describe('validateSkillName', () => {
  test('accepts valid kebab-case names', () => {
    expect(validateSkillName('retry-pipeline').ok).toBe(true)
    expect(validateSkillName('a').ok).toBe(true)
    expect(validateSkillName('my-cool-skill-123').ok).toBe(true)
  })

  test('rejects empty name', () => {
    const result = validateSkillName('')
    expect(result.ok).toBe(false)
  })

  test('rejects name over 64 chars', () => {
    const result = validateSkillName('a'.repeat(65))
    expect(result.ok).toBe(false)
  })

  test('rejects non-kebab-case names', () => {
    expect(validateSkillName('CamelCase').ok).toBe(false)
    expect(validateSkillName('with spaces').ok).toBe(false)
    expect(validateSkillName('with_underscores').ok).toBe(false)
    expect(validateSkillName('-leading-hyphen').ok).toBe(false)
  })
})

describe('validateFrontmatter', () => {
  test('accepts valid frontmatter', () => {
    const result = validateFrontmatter({
      name: 'test-skill',
      description: 'A valid description',
    })
    expect(result.ok).toBe(true)
  })

  test('rejects empty description', () => {
    const result = validateFrontmatter({
      name: 'test-skill',
      description: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('description')
    }
  })

  test('rejects description over 1024 chars', () => {
    const result = validateFrontmatter({
      name: 'test-skill',
      description: 'x'.repeat(1025),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('1024')
    }
  })

  test('rejects invalid skill name in frontmatter', () => {
    const result = validateFrontmatter({
      name: 'BadName',
      description: 'Valid description',
    })
    expect(result.ok).toBe(false)
  })
})

describe('validateRoundTrip', () => {
  test('parses valid SKILL.md content', () => {
    const content =
      '---\nname: test-skill\ndescription: A test skill\n---\n\n# Instructions\n\nDo stuff.'
    const result = validateRoundTrip(content)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe('test-skill')
      expect(result.value.frontmatter.description).toBe('A test skill')
      expect(result.value.body).toContain('# Instructions')
    }
  })

  test('rejects content without frontmatter delimiters', () => {
    const result = validateRoundTrip('# No frontmatter')
    expect(result.ok).toBe(false)
  })

  test('rejects content missing closing delimiter', () => {
    const result = validateRoundTrip('---\nname: test\n# No closing')
    expect(result.ok).toBe(false)
  })

  test('rejects frontmatter missing required name', () => {
    const content = '---\ndescription: missing name\n---\n\n# Body'
    const result = validateRoundTrip(content)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('name')
    }
  })

  test('rejects frontmatter missing required description', () => {
    const content = '---\nname: test-skill\n---\n\n# Body'
    const result = validateRoundTrip(content)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('description')
    }
  })
})

describe('checkNameUniqueness', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('uniqueness-test')
  })

  afterEach(() => {
    cleanupDir(tempDir)
  })

  test('succeeds when name is unique', () => {
    const result = checkNameUniqueness('new-skill', tempDir)
    expect(result.ok).toBe(true)
  })

  test('fails when skill already exists', () => {
    mkdirSync(join(tempDir, 'existing-skill'), { recursive: true })
    const result = checkNameUniqueness('existing-skill', tempDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('already exists')
    }
  })
})

describe('parseSkillResponse', () => {
  test('parses valid JSON response', () => {
    const json = JSON.stringify({
      frontmatter: { name: 'test-skill', description: 'A test skill' },
      body: '# Instructions',
      testScript: 'process.exit(0)',
    })
    const result = parseSkillResponse(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe('test-skill')
      expect(result.value.body).toBe('# Instructions')
      expect(result.value.testScript).toBe('process.exit(0)')
    }
  })

  test('handles markdown code fences', () => {
    const json =
      '```json\n' +
      JSON.stringify({
        frontmatter: { name: 'test-skill', description: 'A test skill' },
        body: '# Instructions',
      }) +
      '\n```'
    const result = parseSkillResponse(json)
    expect(result.ok).toBe(true)
  })

  test('rejects missing frontmatter', () => {
    const result = parseSkillResponse(JSON.stringify({ body: '# test' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('frontmatter')
    }
  })

  test('rejects missing description in frontmatter', () => {
    const json = JSON.stringify({
      frontmatter: { name: 'test-skill' },
      body: '# Instructions',
    })
    const result = parseSkillResponse(json)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('description')
    }
  })
})

describe('writeSkillToStaging', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('staging-test')
  })

  afterEach(() => {
    cleanupDir(tempDir)
  })

  test('writes SKILL.md and test script', () => {
    const skill = makeSkill()
    const result = writeSkillToStaging(skill, tempDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const skillDir = result.value
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir, 'scripts', 'test.ts'))).toBe(true)

      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
      expect(content).toContain('retry-pipeline')
      expect(content).toContain('---')
    }
  })

  test('overwrites existing staging directory (idempotent)', () => {
    const skill = makeSkill()
    // Write first time
    writeSkillToStaging(skill, tempDir)
    // Write again — should not error
    const result = writeSkillToStaging(skill, tempDir)
    expect(result.ok).toBe(true)
  })

  test('creates skill without test script if none provided', () => {
    const skill = makeSkill({ testScript: undefined })
    const result = writeSkillToStaging(skill, tempDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(existsSync(join(result.value, 'scripts'))).toBe(false)
    }
  })
})

describe('buildGenerationPrompt', () => {
  test('includes reflection fields in prompt', () => {
    const reflection = makeReflection()
    const prompt = buildGenerationPrompt(reflection)
    expect(prompt).toContain('retry-pipeline')
    expect(prompt).toContain('Exponential backoff')
    expect(prompt).toContain('pipeline builder pattern')
  })
})

// ── Pipeline integration tests ────────────────────────────────────────

describe('crystallize pipeline', () => {
  let tempDir: string
  let skillDirs: { staging: string; generated: string; core: string }

  beforeEach(() => {
    tempDir = makeTempDir('pipeline-test')
    skillDirs = makeSkillDirs(tempDir)
    mockGenerateText.mockClear()
  })

  afterEach(() => {
    cleanupDir(tempDir)
  })

  // ── Test: Full pipeline success (end-to-end) ─────���───────────────────
  test('full pipeline success: reflect -> generate -> validate -> test -> promote', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))
    const skillJson = JSON.stringify({
      frontmatter: {
        name: 'retry-pipeline',
        description: 'Build data pipelines with automatic retry and exponential backoff',
      },
      body: '# Retry Pipeline\n\nInstructions for building retry pipelines.',
      testScript: 'console.log("test passed"); process.exit(0);',
    })

    // First call is reflect, second is generateSkill
    let callCount = 0
    mockGenerateText.mockImplementation(() => {
      callCount++
      const text = callCount === 1 ? reflectionJson : skillJson
      return Promise.resolve({
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })
    })

    const result = await crystallize('Built a retry pipeline', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false, // Skip git in tests
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe('promoted')
      expect(result.value.skillName).toBe('retry-pipeline')
      expect(result.value.reflection).toBeDefined()
      expect(result.value.reflection!.novelty).toBe(0.9)
      expect(result.value.skillPath).toBe(join(skillDirs.generated, 'retry-pipeline'))
      expect(result.value.testResult).toBeDefined()
      expect(result.value.testResult!.passed).toBe(true)

      // Verify skill exists in generated, not staging
      expect(existsSync(join(skillDirs.generated, 'retry-pipeline', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDirs.staging, 'retry-pipeline'))).toBe(false)
    }
  }, 30_000)

  // ── Test: Pipeline stops when reflection says no ──────────────────────
  test('pipeline stops when reflection says no crystallization needed', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.2 }))

    mockGenerateText.mockImplementation(() =>
      Promise.resolve({
        text: reflectionJson,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      }),
    )

    const result = await crystallize('Simple file rename', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe('no-crystallization')
      expect(result.value.reflection).toBeDefined()
      expect(result.value.reflection!.novelty).toBe(0.2)
      expect(result.value.skillName).toBeUndefined()
    }

    // Should have only called generateText once (for reflection)
    expect(mockGenerateText).toHaveBeenCalledTimes(1)

    // No files should be written to staging
    const stagingContents = existsSync(join(skillDirs.staging, 'retry-pipeline'))
    expect(stagingContents).toBe(false)
  })

  // ── Test: Pipeline stops on test failure ───────���──────────────────���───
  test('pipeline stops on test failure, skill remains in staging', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))
    const skillJson = JSON.stringify({
      frontmatter: {
        name: 'retry-pipeline',
        description: 'Build data pipelines with automatic retry and exponential backoff',
      },
      body: '# Retry Pipeline\n\nInstructions for building retry pipelines.',
      // Test script that fails
      testScript: 'console.error("test failed"); process.exit(1);',
    })

    let callCount = 0
    mockGenerateText.mockImplementation(() => {
      callCount++
      const text = callCount === 1 ? reflectionJson : skillJson
      return Promise.resolve({
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })
    })

    const result = await crystallize('Built a retry pipeline', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe('test-failed')
      expect(result.value.skillName).toBe('retry-pipeline')
      expect(result.value.testResult).toBeDefined()
      expect(result.value.testResult!.passed).toBe(false)

      // Skill should remain in staging
      expect(existsSync(join(skillDirs.staging, 'retry-pipeline', 'SKILL.md'))).toBe(true)
      // Skill should NOT be in generated
      expect(existsSync(join(skillDirs.generated, 'retry-pipeline'))).toBe(false)
    }
  }, 30_000)

  // ── Test: Validation catches bad frontmatter ───���──────────────────────
  test('validation catches missing description field', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))
    // Skill with missing description
    const skillJson = JSON.stringify({
      frontmatter: {
        name: 'retry-pipeline',
        description: '', // empty — invalid
      },
      body: '# Retry Pipeline\n\nInstructions.',
      testScript: 'process.exit(0);',
    })

    let callCount = 0
    mockGenerateText.mockImplementation(() => {
      callCount++
      const text = callCount === 1 ? reflectionJson : skillJson
      return Promise.resolve({
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })
    })

    const result = await crystallize('Built something', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    // The parseSkillResponse should reject this first since description is empty
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('description')
    }
  })

  // ── Test: Duplicate skill name blocked ────────────────────────────────
  test('duplicate skill name in generated directory is blocked', async () => {
    // Pre-create a skill in generated
    const existingDir = join(skillDirs.generated, 'retry-pipeline')
    mkdirSync(existingDir, { recursive: true })
    writeFileSync(
      join(existingDir, 'SKILL.md'),
      '---\nname: retry-pipeline\ndescription: Existing\n---\n\n# Existing',
      'utf-8',
    )

    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))

    mockGenerateText.mockImplementation(() =>
      Promise.resolve({
        text: reflectionJson,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      }),
    )

    const result = await crystallize('Built something', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('already exists')
      expect(result.error.message).toContain('[generate]')
    }
  })

  // ��─ Test: Git commit message format ────────���──────────────────────────
  test('git commit has structured message on promotion', async () => {
    // Set up a temp git repo
    const gitDir = makeTempDir('git-test')
    const gitSkillDirs = makeSkillDirs(gitDir)

    // Initialize a git repo using execFileSync (safe from injection)
    execFileSync('git', ['init'], { cwd: gitDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: gitDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitDir })
    // Create initial commit so git commit works
    writeFileSync(join(gitDir, 'README.md'), '# test', 'utf-8')
    execFileSync('git', ['add', '.'], { cwd: gitDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir })

    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))
    const skillJson = JSON.stringify({
      frontmatter: {
        name: 'retry-pipeline',
        description: 'Build data pipelines with automatic retry and exponential backoff',
      },
      body: '# Retry Pipeline\n\nInstructions.',
      testScript: 'console.log("ok"); process.exit(0);',
    })

    let callCount = 0
    mockGenerateText.mockImplementation(() => {
      callCount++
      const text = callCount === 1 ? reflectionJson : skillJson
      return Promise.resolve({
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })
    })

    const result = await crystallize('Built a retry pipeline', {
      llm: dummyLlm,
      skillDirs: gitSkillDirs,
      autoCommit: true,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe('promoted')
      expect(result.value.commitHash).toBeDefined()
      expect(typeof result.value.commitHash).toBe('string')
      expect(result.value.commitHash!.length).toBeGreaterThan(0)

      // Verify commit message format
      const logOutput = execFileSync('git', ['log', '-1', '--pretty=format:%s'], {
        cwd: gitDir,
      }).toString()
      expect(logOutput).toMatch(/^rsi: crystallize skill 'retry-pipeline' — /)
    }

    cleanupDir(gitDir)
  }, 30_000)

  // ── Test: No test files causes validation failure ─────────────────────
  test('pipeline fails validation when no test script is provided', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.9 }))
    const skillJson = JSON.stringify({
      frontmatter: {
        name: 'retry-pipeline',
        description: 'Build data pipelines with automatic retry and exponential backoff',
      },
      body: '# Retry Pipeline\n\nInstructions.',
      // No testScript!
    })

    let callCount = 0
    mockGenerateText.mockImplementation(() => {
      callCount++
      const text = callCount === 1 ? reflectionJson : skillJson
      return Promise.resolve({
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })
    })

    const result = await crystallize('Built something', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('[validate]')
      expect(result.error.message).toContain('test')
    }
  })

  // ── Test: CrystallizationResult accurately reflects pipeline stage ────
  test('result includes reflection when pipeline stops early', async () => {
    const reflectionJson = JSON.stringify(makeReflection({ novelty: 0.3 }))

    mockGenerateText.mockImplementation(() =>
      Promise.resolve({
        text: reflectionJson,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      }),
    )

    const result = await crystallize('Minor fix', {
      llm: dummyLlm,
      skillDirs,
      autoCommit: false,
      noveltyThreshold: 0.7,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.outcome).toBe('no-crystallization')
      expect(result.value.reflection).toBeDefined()
      expect(result.value.reflection!.taskSummary).toBeDefined()
      // These should be undefined since we stopped before these stages
      expect(result.value.skillName).toBeUndefined()
      expect(result.value.skillPath).toBeUndefined()
      expect(result.value.testResult).toBeUndefined()
      expect(result.value.commitHash).toBeUndefined()
    }
  })
})
