import { describe, test, expect } from 'bun:test'
import { name, description, schema, createExecute } from '@src/tools/reflect'
import { ToolRegistry, createRegistry } from '@src/tools/registry'
import { resolve } from 'node:path'

describe('Reflect Tool', () => {
  test('exports correct tool interface', () => {
    expect(name).toBe('reflect')
    expect(typeof description).toBe('string')
    expect(description.length).toBeGreaterThan(0)
    expect(schema.safeParse({ taskSummary: 'did something' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
  })

  test('execute without LLM returns descriptive error', async () => {
    const execute = createExecute()
    const result = await execute({ taskSummary: 'test task' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires an LLM instance')
  })

  // -----------------------------------------------------------------------
  // Feature test: Tool registered in registry
  // -----------------------------------------------------------------------
  test('tool is registered in the built-in tool registry', async () => {
    const registry = await createRegistry()
    const tool = registry.getTool('reflect')

    expect(tool).toBeDefined()
    expect(tool!.name).toBe('reflect')
    expect(tool!.description).toContain('reflection')
    expect(tool!.schema).toBeDefined()
  })

  test('tool is discoverable via filesystem discovery', async () => {
    const registry = new ToolRegistry()
    const toolsDir = resolve(import.meta.dir, '../../src/tools')
    await registry.discover(toolsDir)

    const tool = registry.getTool('reflect')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('reflect')
  })

  test('createExecute with mock LLM produces valid reflection', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Implemented error retry logic',
      novelty: 0.8,
      generalizability: 0.75,
      proposedSkillName: 'error-retry',
      proposedSkillDescription: 'Retries failed operations with exponential backoff',
      keySteps: ['Detect error', 'Calculate backoff', 'Retry'],
      reasoning: 'Novel retry pattern not covered by existing skills.',
      shouldCrystallize: true,
    })

    const mockLLM = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: mockResponse }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: { inputTokens: 10, outputTokens: 20 },
        warnings: [],
      }),
      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as import('ai').LanguageModel

    const execute = createExecute({ llm: mockLLM, noveltyThreshold: 0.7 })
    const result = await execute({ taskSummary: 'Implemented error retry logic' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.novelty).toBe(0.8)
    expect(result.value.shouldCrystallize).toBe(true)
  })

  test('shouldCrystallize is recalculated based on configured threshold', async () => {
    // LLM says shouldCrystallize: true, but scores are below our high threshold
    const mockResponse = JSON.stringify({
      taskSummary: 'Did something',
      novelty: 0.75,
      generalizability: 0.72,
      reasoning: 'Decent approach.',
      shouldCrystallize: true,
    })

    const mockLLM = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: mockResponse }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: { inputTokens: 10, outputTokens: 20 },
        warnings: [],
      }),
      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as import('ai').LanguageModel

    // With threshold 0.8, scores of 0.75 and 0.72 should NOT crystallize
    const execute = createExecute({ llm: mockLLM, noveltyThreshold: 0.8 })
    const result = await execute({ taskSummary: 'Did something' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The tool overrides the LLM's decision based on configured threshold
    expect(result.value.shouldCrystallize).toBe(false)
  })
})
