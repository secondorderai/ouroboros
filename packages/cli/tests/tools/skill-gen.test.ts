import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  name,
  description,
  schema,
  createExecute,
  execute,
  type SkillGenInput,
} from '@src/tools/skill-gen'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

const VALID_LLM_OUTPUT = `Generated skill:

\`\`\`description
Creates deterministic regression tests for agent workflows.
\`\`\`

\`\`\`markdown
# Agent Workflow Regression Tests

Use this skill when adding deterministic tests for agent workflows.
\`\`\`

\`\`\`typescript
import { describe, test, expect } from 'bun:test'

describe('generated skill test', () => {
  test('passes', () => {
    expect(true).toBe(true)
  })
})
\`\`\`
`

function mockModelReturning(text: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-skill-gen-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error('doStream not used')
    },
  } as unknown as LanguageModel
}

function validInput(overrides: Partial<SkillGenInput['reflectionRecord']> = {}): SkillGenInput {
  return {
    reflectionRecord: {
      taskSummary: 'Added deterministic workflow tests',
      novelty: 0.85,
      generalizability: 0.9,
      proposedSkillName: 'agent-workflow-regression-tests',
      proposedSkillDescription: 'Creates deterministic workflow regression tests',
      keySteps: ['Identify behavior', 'Use mock LLMs', 'Assert durable side effects'],
      reasoning: 'Workflow regression tests prevent repeated agent regressions.',
      shouldCrystallize: true,
      ...overrides,
    },
  }
}

describe('SkillGenTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-skill-gen-tool')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('skill-gen')
    expect(typeof description).toBe('string')
    expect(description).toContain('Generate a new skill')
    expect(schema.safeParse(validInput()).success).toBe(true)
    expect(schema.safeParse({ reflectionRecord: { taskSummary: 'missing fields' } }).success).toBe(
      false,
    )
  })

  test('default execute returns dependency injection error', async () => {
    const result = await execute()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires LLM dependency injection')
  })

  test('createExecute writes a generated skill to generated', async () => {
    const runSkillGen = createExecute({
      llm: mockModelReturning(VALID_LLM_OUTPUT),
      basePath: tempDir,
    })

    const result = await runSkillGen(validInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skillName).toBe('agent-workflow-regression-tests')
    expect(result.value.path).toContain('skills/generated/agent-workflow-regression-tests')
    expect(existsSync(join(result.value.path, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(result.value.path, 'scripts', 'test.ts'))).toBe(true)
  })

  test('createExecute rejects non-crystallizable reflection records', async () => {
    const runSkillGen = createExecute({
      llm: mockModelReturning(VALID_LLM_OUTPUT),
      basePath: tempDir,
    })

    const result = await runSkillGen(validInput({ shouldCrystallize: false }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('shouldCrystallize: false')
  })
})
