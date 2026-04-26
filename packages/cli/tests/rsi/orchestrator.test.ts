/**
 * RSI Orchestrator Tests
 *
 * Feature tests for the autonomous improvement cycle:
 * - Auto-reflection after task completion
 * - Crystallization triggers on high novelty
 * - No crystallization on low novelty
 * - RSI error doesn't crash agent
 * - --no-rsi disables hooks
 * - Dream cycle on session end
 * - Evolution log entries from RSI
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent, type AgentEvent } from '@src/agent'
import { RSIOrchestrator } from '@src/rsi/orchestrator'
import type { RSIEvent } from '@src/rsi/types'
import { getEntries } from '@src/rsi/evolution-log'
import { ToolRegistry } from '@src/tools/registry'
import type { OuroborosConfig } from '@src/config'
import { configSchema } from '@src/config'
import { createMockModel, textBlock, finishStop } from '../helpers/mock-llm'
import { makeTempDir, cleanupTempDir } from '../helpers/test-utils'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

// ── Helpers ──────────────────────────────────────────────────────────

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown>
    ? T[K]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K]
}

function makeConfig(overrides?: DeepPartial<OuroborosConfig>): OuroborosConfig {
  const base = configSchema.parse({})
  return {
    ...base,
    ...overrides,
    model: { ...base.model, ...overrides?.model },
    permissions: { ...base.permissions, ...overrides?.permissions },
    skillDirectories: overrides?.skillDirectories ?? base.skillDirectories,
    agent: {
      ...base.agent,
      ...overrides?.agent,
      maxSteps: { ...base.agent.maxSteps, ...overrides?.agent?.maxSteps },
    },
    memory: { ...base.memory, ...overrides?.memory },
    rsi: { ...base.rsi, ...overrides?.rsi },
    artifacts: {
      ...base.artifacts,
      ...overrides?.artifacts,
      cdnAllowlist: overrides?.artifacts?.cdnAllowlist ?? base.artifacts.cdnAllowlist,
    },
  }
}

function reflectionJson(novelty: number, generalizability: number, crystallize: boolean): string {
  return JSON.stringify({
    taskSummary: 'Test task completed',
    novelty,
    generalizability,
    proposedSkillName: crystallize ? 'test-skill' : undefined,
    proposedSkillDescription: crystallize ? 'A test skill' : undefined,
    keySteps: crystallize ? ['Step 1', 'Step 2'] : undefined,
    shouldCrystallize: crystallize,
    reasoning: 'Test reasoning',
  })
}

function skillGenOutput(): string {
  return `Here is the generated skill:

\`\`\`description
A test skill for testing the RSI pipeline. Activate when testing crystallization.
\`\`\`

\`\`\`markdown
# Test Skill

## Steps
1. Step 1
2. Step 2
\`\`\`

\`\`\`typescript
import { describe, it, expect } from 'bun:test'

describe('test-skill', () => {
  it('should pass', () => {
    expect(1 + 1).toBe(2)
  })
})
\`\`\`
`
}

/**
 * Create a mock model that supports both doGenerate and doStream.
 * `generateResponses` are consumed sequentially by doGenerate calls.
 * `streamTurns` are consumed sequentially by doStream calls.
 */
function createDualMockModel(
  streamTurns: LanguageModelV3StreamPart[][],
  generateResponses: string[],
): LanguageModel {
  let streamIndex = 0
  let generateIndex = 0

  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-dual-model',
    supportedUrls: {},

    doGenerate: async () => {
      const text = generateResponses[generateIndex] ?? ''
      generateIndex++
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }
    },

    doStream: async () => {
      const parts = streamTurns[streamIndex] ?? [
        { type: 'text-start' as const, id: 'fallback' },
        { type: 'text-delta' as const, id: 'fallback', delta: '[No more scripted turns]' },
        { type: 'text-end' as const, id: 'fallback' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: {
              total: 0,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 0, text: undefined, reasoning: undefined },
          },
        },
      ]
      streamIndex++

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  }

  return model as LanguageModel
}

/**
 * Create a mock model whose doGenerate throws (simulates LLM errors for RSI).
 */
function createFailingGenerateModel(streamTurns: LanguageModelV3StreamPart[][]): LanguageModel {
  let streamIndex = 0

  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-failing-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error('LLM generation failed')
    },

    doStream: async () => {
      const parts = streamTurns[streamIndex] ?? []
      streamIndex++

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  }

  return model as LanguageModel
}

// ── Tests ────────────────────────────────────────────────────────────

describe('RSI Orchestrator', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('rsi-orchestrator')
    mkdirSync(join(tempDir, 'memory', 'topics'), { recursive: true })
    mkdirSync(join(tempDir, 'skills', 'core'), { recursive: true })
    mkdirSync(join(tempDir, 'skills', 'generated'), { recursive: true })
    mkdirSync(join(tempDir, 'skills', 'staging'), { recursive: true })
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('auto-reflection after task completion', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: true, noveltyThreshold: 0.7 },
    })

    // Stream turns: agent response. Generate responses: RSI reflection.
    const model = createDualMockModel(
      [[...textBlock('Task completed successfully.'), finishStop()]],
      [reflectionJson(0.3, 0.3, false)],
    )

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()
    const agentEvents: AgentEvent[] = []

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: (event) => agentEvents.push(event),
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    await agent.run('Do a test task')

    // Wait for async RSI to complete
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Agent should have completed normally
    const turnComplete = agentEvents.find((e) => e.type === 'turn-complete')
    expect(turnComplete).toBeDefined()

    // RSI reflection should have fired
    const reflectionEvent = rsiEvents.find((e) => e.type === 'rsi-reflection')
    expect(reflectionEvent).toBeDefined()
    if (reflectionEvent?.type === 'rsi-reflection') {
      expect(reflectionEvent.reflection.novelty).toBe(0.3)
    }
  })

  test('crystallization triggers on high novelty', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: true, noveltyThreshold: 0.5 },
    })

    // Generate responses: 1) reflection (high novelty), 2) crystallize reflect, 3) skill generation
    const model = createDualMockModel(
      [[...textBlock('Task done.'), finishStop()]],
      [reflectionJson(0.8, 0.9, true), reflectionJson(0.8, 0.9, true), skillGenOutput()],
    )

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: () => {},
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    await agent.run('Complex task requiring novel approach')

    // Wait for async RSI to complete
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Both reflection and crystallization events should fire
    const reflectionEvent = rsiEvents.find((e) => e.type === 'rsi-reflection')
    expect(reflectionEvent).toBeDefined()

    const crystalEvent = rsiEvents.find((e) => e.type === 'rsi-crystallization')
    expect(crystalEvent).toBeDefined()
    if (crystalEvent?.type === 'rsi-crystallization') {
      expect(crystalEvent.result.outcome).toBe('promoted')
    }
  })

  test('no crystallization on low novelty', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: true, noveltyThreshold: 0.7 },
    })

    const model = createDualMockModel(
      [[...textBlock('Done.'), finishStop()]],
      [reflectionJson(0.2, 0.3, false)],
    )

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: () => {},
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    await agent.run('Simple task')

    // Wait for async RSI
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Reflection should fire
    const reflectionEvent = rsiEvents.find((e) => e.type === 'rsi-reflection')
    expect(reflectionEvent).toBeDefined()

    // No crystallization event should fire
    const crystalEvent = rsiEvents.find((e) => e.type === 'rsi-crystallization')
    expect(crystalEvent).toBeUndefined()
  })

  test('RSI error does not crash agent', async () => {
    const rsiEvents: RSIEvent[] = []
    const agentEvents: AgentEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: true, noveltyThreshold: 0.7 },
    })

    // Agent streaming works fine, but doGenerate (used by RSI) throws
    const model = createFailingGenerateModel([[...textBlock('Task completed.'), finishStop()]])

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: (event) => agentEvents.push(event),
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    // This should NOT throw even though RSI will fail
    const result = await agent.run('Do something')

    // Wait for async RSI to attempt and fail
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Agent completed normally
    expect(result.text).toContain('Task completed')
    expect(result.maxIterationsReached).toBe(false)

    // RSI error event should have fired
    const errorEvent = rsiEvents.find((e) => e.type === 'rsi-error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === 'rsi-error') {
      expect(errorEvent.stage).toBe('reflection')
    }
  })

  test('no RSI events when orchestrator is not set', async () => {
    const agentEvents: AgentEvent[] = []

    const model = createMockModel([[...textBlock('Simple response.'), finishStop()]])

    const registry = new ToolRegistry()

    // Agent created WITHOUT rsiOrchestrator (simulates --no-rsi)
    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: (event) => agentEvents.push(event),
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
    })

    const result = await agent.run('Test task')

    // Wait for any potential async RSI
    await new Promise((resolve) => setTimeout(resolve, 200))

    // No RSI events should have fired
    const rsiEvents = agentEvents.filter(
      (e) =>
        e.type === 'rsi-reflection' ||
        e.type === 'rsi-crystallization' ||
        e.type === 'rsi-dream' ||
        e.type === 'rsi-error',
    )
    expect(rsiEvents).toHaveLength(0)

    // Agent should have completed normally
    expect(result.text).toContain('Simple response')
  })

  test('dream cycle on session end', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      memory: { consolidationSchedule: 'session-end' },
    })

    // Create some topic files to consolidate
    writeFileSync(
      join(tempDir, 'memory', 'topics', 'topic-a.md'),
      '# Topic A\n\nSome content about topic A.',
      'utf-8',
    )
    writeFileSync(
      join(tempDir, 'memory', 'topics', 'topic-b.md'),
      '# Topic B\n\nSome content about topic B.',
      'utf-8',
    )

    const model = createMockModel([[...textBlock('Done.'), finishStop()]])

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: () => {},
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    // End the session
    await agent.shutdown()

    // Dream event should fire
    const dreamEvent = rsiEvents.find((e) => e.type === 'rsi-dream')
    expect(dreamEvent).toBeDefined()
    if (dreamEvent?.type === 'rsi-dream') {
      expect(dreamEvent.result.topicsMerged).toBeDefined()
    }

    // Evolution log should have a memory-consolidated entry
    const entries = getEntries({ type: 'memory-consolidated' }, tempDir)
    expect(entries.ok).toBe(true)
    if (entries.ok) {
      expect(entries.value.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('evolution log entries from RSI reflection', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: true, noveltyThreshold: 0.7 },
    })

    const model = createDualMockModel(
      [[...textBlock('Task done.'), finishStop()]],
      [reflectionJson(0.5, 0.6, false)],
    )

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: () => {},
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    await agent.run('Some task')

    // Wait for RSI
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Evolution log should contain reflection entry
    const entries = getEntries({ type: 'memory-updated' }, tempDir)
    expect(entries.ok).toBe(true)
    if (entries.ok) {
      expect(entries.value.length).toBeGreaterThanOrEqual(1)
      expect(entries.value[0].type).toBe('memory-updated')
      expect(entries.value[0].motivation).toContain('0.5')
    }
  })

  test('no dream cycle when consolidation schedule is manual', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      memory: { consolidationSchedule: 'manual' },
    })

    const model = createMockModel([[...textBlock('Done.'), finishStop()]])

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const registry = new ToolRegistry()

    const agent = new Agent({
      model,
      toolRegistry: registry,
      onEvent: () => {},
      systemPromptBuilder: () => 'You are a test assistant.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      rsiOrchestrator: orchestrator,
    })

    await agent.shutdown()

    // No dream event should fire
    const dreamEvent = rsiEvents.find((e) => e.type === 'rsi-dream')
    expect(dreamEvent).toBeUndefined()
  })

  test('manual dream trigger via orchestrator', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      memory: { consolidationSchedule: 'manual' },
    })

    writeFileSync(
      join(tempDir, 'memory', 'topics', 'test-topic.md'),
      '# Test Topic\n\nSome test content.',
      'utf-8',
    )

    const model = createMockModel([])

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    const result = await orchestrator.triggerDream({ mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sessionsAnalyzed).toBeDefined()
    }

    // Dream event should fire
    const dreamEvent = rsiEvents.find((e) => e.type === 'rsi-dream')
    expect(dreamEvent).toBeDefined()
  })

  test('autoReflect: false disables post-task reflection', async () => {
    const rsiEvents: RSIEvent[] = []

    const config = makeConfig({
      rsi: { autoReflect: false, noveltyThreshold: 0.7 },
    })

    const model = createMockModel([[...textBlock('Done.'), finishStop()]])

    const orchestrator = new RSIOrchestrator({
      config,
      llm: model,
      onEvent: (event) => rsiEvents.push(event),
      basePath: tempDir,
      autoCommit: false,
    })

    // Directly call onTaskComplete — should be a no-op
    await orchestrator.onTaskComplete('Test task')

    // No reflection events should fire
    const reflectionEvent = rsiEvents.find((e) => e.type === 'rsi-reflection')
    expect(reflectionEvent).toBeUndefined()
  })
})
