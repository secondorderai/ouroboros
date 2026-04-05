/**
 * Tests for RSI Crystallize Module (SkillGenTool — Ticket 02)
 *
 * Covers all six feature tests from the ticket specification:
 *   1. Generates valid skill directory
 *   2. Frontmatter conforms to spec
 *   3. Rejects non-crystallizable reflection
 *   4. Rejects duplicate skill name
 *   5. Generated test script is valid TypeScript
 *   6. Malformed LLM output handled gracefully
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { LanguageModel } from 'ai'

import type { LanguageModelV3 } from '@ai-sdk/provider'

import {
  type ReflectionRecord,
  generateSkill,
  writeSkillToStaging,
  parseSkillResponse,
  validateSkillName,
  checkNameUniqueness,
  validateRoundTrip,
} from '@src/rsi/crystallize'
import { createExecute, type SkillGenInput } from '@src/tools/skill-gen'
import { makeTempDir, cleanupTempDir } from '../helpers/test-utils'

// ── Fixtures ──────────────────────────────────────────────────────────

function makeReflection(overrides?: Partial<ReflectionRecord>): ReflectionRecord {
  return {
    taskSummary: 'Implemented cursor-based pagination for a REST API',
    keySteps: [
      'Define a cursor schema using Zod',
      'Implement the paginate() helper that wraps DB queries',
      'Return next_cursor in the response body',
    ],
    shouldCrystallize: true,
    proposedSkillName: 'test-skill',
    generalizability: 0.85,
    reasoning: 'Cursor-based pagination is a common pattern applicable across many REST APIs.',
    ...overrides,
  }
}

/** Well-formed LLM output with all three required blocks */
const VALID_LLM_OUTPUT = `Here is the generated skill:

\`\`\`description
Generates cursor-based pagination logic for REST APIs. Activate when the user needs to implement paginated endpoints over database query results, handling cursor encoding, page size limits, and next-page token generation.
\`\`\`

\`\`\`markdown
# Cursor-Based Pagination for REST APIs

## When to Use

Apply this skill when building REST API endpoints that return paginated collections.

## Steps

1. **Define a cursor schema** — Use Zod to validate the cursor parameter from the request.
2. **Implement paginate() helper** — Wrap your database query to accept cursor and limit params.
3. **Return next_cursor** — Include a \`next_cursor\` field in the response for the client.

## Example

\\\`\\\`\\\`typescript
const result = await paginate(db, { cursor, limit: 20 });
return { data: result.items, next_cursor: result.nextCursor };
\\\`\\\`\\\`

## Edge Cases

- If cursor is invalid or expired, return a 400 error with a clear message.
- If limit is 0 or negative, default to 20.
\`\`\`

\`\`\`typescript
import { describe, it, expect } from 'bun:test'

describe('cursor-based pagination', () => {
  it('should encode and decode cursor correctly', () => {
    const id = 42
    const cursor = Buffer.from(String(id)).toString('base64')
    const decoded = Number(Buffer.from(cursor, 'base64').toString())
    expect(decoded).toBe(id)
  })

  it('should handle empty cursor (first page)', () => {
    const cursor = undefined
    const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString()) : 0
    expect(offset).toBe(0)
  })
})
\`\`\`
`

/**
 * Create a mock model that supports doGenerate (for generateText/generateResponse).
 * Returns the specified text as generated output.
 */
function mockModelReturning(text: string): LanguageModel {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-generate-model',
    supportedUrls: {},

    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 10,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),

    doStream: async () => {
      throw new Error('doStream not used by generateText')
    },
  }

  return model as LanguageModel
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('RSI Crystallize Module', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir('rsi-crystallize')
    // Create skills directory structure
    mkdirSync(join(tmpDir, 'skills', 'core'), { recursive: true })
    mkdirSync(join(tmpDir, 'skills', 'generated'), { recursive: true })
    mkdirSync(join(tmpDir, 'skills', 'staging'), { recursive: true })
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  // ── Test 1: Generates valid skill directory ─────────────────────
  describe('generates valid skill directory', () => {
    it('should produce SKILL.md and scripts/test.ts in staging', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const skillDir = writeResult.value
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir, 'scripts', 'test.ts'))).toBe(true)

      // Verify SKILL.md has valid YAML frontmatter
      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
      expect(content.trimStart().startsWith('---')).toBe(true)

      const endIndex = content.trimStart().indexOf('---', 3)
      expect(endIndex).toBeGreaterThan(0)

      const yamlBlock = content.trimStart().slice(3, endIndex).trim()
      const parsed = parseYaml(yamlBlock)
      expect(parsed.name).toBe('test-skill')
    })
  })

  // ── Test 2: Frontmatter conforms to spec ────────────────────────
  describe('frontmatter conforms to spec', () => {
    it('should include all required agentskills.io fields', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const content = readFileSync(join(writeResult.value, 'SKILL.md'), 'utf-8')
      const endIndex = content.trimStart().indexOf('---', 3)
      const yamlBlock = content.trimStart().slice(3, endIndex).trim()
      const fm = parseYaml(yamlBlock)

      // Required fields
      expect(fm.name).toBe('test-skill')
      expect(typeof fm.description).toBe('string')
      expect(fm.description.length).toBeGreaterThan(0)
      expect(fm.description.length).toBeLessThanOrEqual(1024)
      expect(fm.license).toBe('Apache-2.0')

      // Metadata
      expect(fm.metadata).toBeDefined()
      expect(fm.metadata.generated).toBe('true')
      expect(fm.metadata.author).toBe('ouroboros-rsi')
      expect(fm.metadata.version).toBe('1.0')
      expect(fm.metadata.confidence).toBe(0.85)
      expect(fm.metadata.source_task).toBe('Implemented cursor-based pagination for a REST API')
    })
  })

  // ── Test 3: Rejects non-crystallizable reflection ───────────────
  describe('rejects non-crystallizable reflection', () => {
    it('should return error for shouldCrystallize: false', async () => {
      const record = makeReflection({ shouldCrystallize: false })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('shouldCrystallize: false')
    })

    it('should reject via the tool execute function', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: {
          ...makeReflection({ shouldCrystallize: false }),
        },
      }

      const result = await execute(input)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('shouldCrystallize: false')
    })
  })

  // ── Test 4: Rejects duplicate skill name ────────────────────────
  describe('rejects duplicate skill name', () => {
    it('should error when skill name already exists in skills/core/', async () => {
      // Create an existing skill in core
      const existingDir = join(tmpDir, 'skills', 'core', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
      expect(writeResult.error.message).toContain('existing-skill')
    })

    it('should error when skill name already exists in skills/staging/', async () => {
      const existingDir = join(tmpDir, 'skills', 'staging', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
    })

    it('should error when skill name already exists in skills/generated/', async () => {
      const existingDir = join(tmpDir, 'skills', 'generated', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
    })
  })

  // ── Test 5: Generated test script is valid TypeScript ───────────
  describe('generated test script is valid TypeScript', () => {
    it('should produce syntactically valid TS in scripts/test.ts', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const testScript = readFileSync(join(writeResult.value, 'scripts', 'test.ts'), 'utf-8')

      // Basic validity checks: contains expected imports and structure
      expect(testScript).toContain('import')
      expect(testScript).toContain('bun:test')
      expect(testScript).toContain('describe')
      expect(testScript).toContain('expect')

      // Verify it's parseable by checking for balanced braces
      const opens = (testScript.match(/\{/g) || []).length
      const closes = (testScript.match(/\}/g) || []).length
      expect(opens).toBe(closes)
    })
  })

  // ── Test 6: Malformed LLM output handled gracefully ─────────────
  describe('malformed LLM output handled gracefully', () => {
    it('should error when LLM returns no code blocks', async () => {
      const record = makeReflection()
      const llm = mockModelReturning('I cannot generate a skill right now.')

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('description')
    })

    it('should error when LLM output is missing the markdown block', async () => {
      const incompleteOutput = `
\`\`\`description
A test skill description.
\`\`\`
`
      const record = makeReflection()
      const llm = mockModelReturning(incompleteOutput)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('markdown')
    })

    it('should error when LLM output is missing the typescript block', async () => {
      const incompleteOutput = `
\`\`\`description
A test skill description.
\`\`\`

\`\`\`markdown
# Instructions
Do the thing.
\`\`\`
`
      const record = makeReflection()
      const llm = mockModelReturning(incompleteOutput)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('typescript')
    })

    it('should error when LLM returns empty text', async () => {
      const record = makeReflection()
      const llm = mockModelReturning('')

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('empty')
    })
  })

  // ── Unit tests for validators ───────────────────────────────────
  describe('validateSkillName', () => {
    it('should accept valid kebab-case names', () => {
      expect(validateSkillName('my-skill').ok).toBe(true)
      expect(validateSkillName('a').ok).toBe(true)
      expect(validateSkillName('cursor-pagination-v2').ok).toBe(true)
    })

    it('should reject empty names', () => {
      const r = validateSkillName('')
      expect(r.ok).toBe(false)
    })

    it('should reject names over 64 characters', () => {
      const r = validateSkillName('a'.repeat(65))
      expect(r.ok).toBe(false)
    })

    it('should reject non-kebab-case names', () => {
      expect(validateSkillName('MySkill').ok).toBe(false)
      expect(validateSkillName('my_skill').ok).toBe(false)
      expect(validateSkillName('my skill').ok).toBe(false)
      expect(validateSkillName('-leading-dash').ok).toBe(false)
    })
  })

  describe('checkNameUniqueness', () => {
    it('should return ok when name is unique', () => {
      const r = checkNameUniqueness('brand-new-skill', tmpDir)
      expect(r.ok).toBe(true)
    })

    it('should return error when name exists', () => {
      mkdirSync(join(tmpDir, 'skills', 'core', 'taken-name'), { recursive: true })
      const r = checkNameUniqueness('taken-name', tmpDir)
      expect(r.ok).toBe(false)
    })
  })

  describe('parseSkillResponse', () => {
    it('should extract all three blocks from valid output', () => {
      const record = makeReflection()
      const result = parseSkillResponse(VALID_LLM_OUTPUT, record)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.name).toBe('test-skill')
      expect(result.value.frontmatter.name).toBe('test-skill')
      expect(result.value.frontmatter.license).toBe('Apache-2.0')
      expect(result.value.frontmatter.metadata.author).toBe('ouroboros-rsi')
      expect(result.value.body).toContain('Cursor-Based Pagination')
      expect(result.value.testScript).toContain('bun:test')
    })
  })

  describe('validateRoundTrip', () => {
    it('should accept valid SKILL.md content', () => {
      const content = `---
name: test
description: A test skill
---

# Body here
`
      expect(validateRoundTrip(content).ok).toBe(true)
    })

    it('should reject content without frontmatter', () => {
      expect(validateRoundTrip('# No frontmatter').ok).toBe(false)
    })

    it('should reject content with unclosed frontmatter', () => {
      expect(validateRoundTrip('---\nname: test\n').ok).toBe(false)
    })
  })

  // ── Integration: tool execute function ──────────────────────────
  describe('SkillGenTool createExecute', () => {
    it('should produce a complete skill via the tool interface', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: makeReflection(),
      }

      const result = await execute(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.skillName).toBe('test-skill')
      expect(result.value.path).toContain('skills/staging/test-skill')
      expect(existsSync(join(result.value.path, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(result.value.path, 'scripts', 'test.ts'))).toBe(true)
    })

    it('should pass optional transcript to generation', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: makeReflection(),
        taskTranscript: 'User asked for cursor-based pagination implementation...',
      }

      const result = await execute(input)
      expect(result.ok).toBe(true)
    })
  })
})
