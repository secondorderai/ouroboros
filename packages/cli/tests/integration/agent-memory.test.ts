/**
 * Integration Test: Agent + Memory
 *
 * Verifies that the Agent's system prompt includes MEMORY.md content,
 * the agent can use the memory tool during a task, and session
 * transcripts are stored in SQLite.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent, estimateContextUsage } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { TranscriptStore } from '@src/memory/transcripts'
import { getMemoryIndex } from '@src/memory/index'
import { readCheckpoint, writeCheckpoint } from '@src/memory/checkpoints'
import { resolveCheckpointPath, resolveObservationLogPath } from '@src/memory/paths'
import { readObservations } from '@src/memory/observations'
import { readTopic } from '@src/memory/topics'
import { createExecute as createMemoryExecute } from '@src/tools/memory'
import { buildSystemPrompt } from '@src/llm/prompt'
import { llmUserContentToText } from '@src/llm/types'
import { z } from 'zod'
import { ok } from '@src/types'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolveDailyMemoryPath } from '@src/memory/paths'
import { configSchema } from '@src/config'
import { getEntries } from '@src/rsi/evolution-log'
import {
  createMockModel,
  createInspectingMockModel,
  textBlock,
  toolCallBlock,
  finishStop,
  finishToolCalls,
} from '../helpers/mock-llm'
import {
  makeTempDir,
  cleanupTempDir,
  setupMemoryDir,
  makeAgentOptions,
} from '../helpers/test-utils'

describe('Agent + Memory Integration', () => {
  let tempDir: string
  let registry: ToolRegistry

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-memory-test')
    registry = new ToolRegistry()
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  // -------------------------------------------------------------------
  // Test: System prompt includes MEMORY.md content
  // -------------------------------------------------------------------
  test('system prompt includes MEMORY.md content when memoryProvider is configured', async () => {
    setupMemoryDir(tempDir, '# Project Knowledge\n\n- TypeScript project\n- Uses Bun runtime')

    let capturedSystemPrompt = ''

    const model = createInspectingMockModel((prompt, _callIndex) => {
      // The prompt is an array of messages; the first one is the system message
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((m) => m.role === 'system')
      if (systemMsg) {
        capturedSystemPrompt = String(
          Array.isArray(systemMsg.content)
            ? (systemMsg.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : systemMsg.content,
        )
      }
      return [...textBlock('I can see the memory context.'), finishStop()]
    })

    const memoryContent = getMemoryIndex(tempDir)
    const agent = new Agent(
      makeAgentOptions(model, registry, {
        systemPromptBuilder: buildSystemPrompt,
        memoryProvider: () => (memoryContent.ok ? memoryContent.value : ''),
      }),
    )

    await agent.run('What do you know about the project?')

    // The system prompt should contain the memory content
    expect(capturedSystemPrompt).toContain('Project Knowledge')
    expect(capturedSystemPrompt).toContain('TypeScript project')
    expect(capturedSystemPrompt).toContain('Uses Bun runtime')
    expect(capturedSystemPrompt).toContain('Memory Context')
    expect(capturedSystemPrompt).toContain('Durable Memory')
  })

  test('agent loads layered durable, checkpoint, and working memory from disk', async () => {
    setupMemoryDir(tempDir, '# Project Knowledge\n\n## Durable Facts\n- Uses Bun runtime')
    writeCheckpoint(
      {
        sessionId: 'agent-session',
        updatedAt: '2026-04-15T12:00:00.000Z',
        goal: 'Keep layered memory visible',
        currentPlan: ['Render prompt'],
        constraints: ['Preserve checkpoint integrity'],
        decisionsMade: ['Use the layered loader'],
        filesInPlay: ['packages/cli/src/agent.ts'],
        completedWork: ['Wired durable memory'],
        openLoops: ['Add checkpoint assertions'],
        nextBestStep: 'Verify prompt content',
        durableMemoryCandidates: [],
        skillCandidates: [],
      },
      tempDir,
    )
    mkdirSync(dirname(resolveDailyMemoryPath('2026-04-15', tempDir)), { recursive: true })
    writeFileSync(
      resolveDailyMemoryPath('2026-04-15', tempDir),
      '# Working Notes\n\n- Recent context still matters',
      'utf-8',
    )

    let capturedSystemPrompt = ''
    const model = createInspectingMockModel((prompt) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((message) => message.role === 'system')
      if (systemMsg) {
        capturedSystemPrompt = String(
          Array.isArray(systemMsg.content)
            ? (systemMsg.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : systemMsg.content,
        )
      }
      return [...textBlock('Layered memory loaded.'), finishStop()]
    })

    const config = configSchema.parse({
      memory: {
        dailyLoadDays: 1,
        durableMemoryBudgetTokens: 200,
        checkpointBudgetTokens: 200,
        workingMemoryBudgetTokens: 200,
      },
    })

    const agent = new Agent(
      makeAgentOptions(model, registry, {
        systemPromptBuilder: buildSystemPrompt,
        memoryProvider: undefined,
        config,
        basePath: tempDir,
        sessionId: 'agent-session',
      }),
    )

    await agent.run('What do you know right now?')

    expect(capturedSystemPrompt).toContain('### Durable Memory')
    expect(capturedSystemPrompt).toContain('Uses Bun runtime')
    expect(capturedSystemPrompt).toContain('### Checkpoint Memory')
    expect(capturedSystemPrompt).toContain('Preserve checkpoint integrity')
    expect(capturedSystemPrompt).toContain('### Working Memory')
    expect(capturedSystemPrompt).toContain('Recent context still matters')
  })

  test('estimates context usage across layered memory and conversation history', () => {
    const usage = estimateContextUsage({
      systemPrompt:
        'System guidance.\n\n### Durable Memory\nKnown fact\n\n### Checkpoint Memory\nKeep the task moving',
      memorySections: {
        durableMemory: 'Known fact',
        checkpointMemory: 'Keep the task moving',
        workingMemory: 'Recent notes',
      },
      conversationHistory: [
        { role: 'user', content: 'Investigate the long-running task state.' },
        { role: 'assistant', content: 'I reviewed the current plan.' },
        {
          role: 'tool',
          content: [{ toolCallId: 'call_1', toolName: 'bash', result: { output: 'done' } }],
        },
      ],
      contextWindowTokens: 200,
      warnRatio: 0.2,
      flushRatio: 0.4,
      compactRatio: 0.8,
    })

    expect(usage.systemPromptTokens).toBeGreaterThan(0)
    expect(usage.durableMemoryTokens).toBeGreaterThan(0)
    expect(usage.checkpointMemoryTokens).toBeGreaterThan(0)
    expect(usage.workingMemoryTokens).toBeGreaterThan(0)
    expect(usage.liveConversationTokens).toBeGreaterThan(0)
    expect(usage.toolResultTokens).toBeGreaterThan(0)
    expect(usage.estimatedTotalTokens).toBeGreaterThan(
      usage.durableMemoryTokens + usage.checkpointMemoryTokens,
    )
    expect(usage.usageRatio).not.toBeNull()
  })

  test('flushes observations and rewrites the checkpoint before compaction', async () => {
    setupMemoryDir(tempDir, '# Durable Memory\n\n- Preserve active tasks')

    const config = configSchema.parse({
      memory: {
        contextWindowTokens: 400,
        warnRatio: 0.2,
        flushRatio: 0.35,
        compactRatio: 0.95,
        tailMessageCount: 2,
      },
    })

    const longMessage = 'Plan the migration and keep all constraints intact. '.repeat(10).trim()
    const history = [
      { role: 'user' as const, content: longMessage },
      { role: 'assistant' as const, content: 'Captured the repository constraints and plan.' },
      { role: 'user' as const, content: 'Document the open loops before continuing.' },
    ]

    const agent = new Agent(
      makeAgentOptions(
        createMockModel([
          [...textBlock('Checkpoint refreshed before the next turn.'), finishStop()],
        ]),
        registry,
        {
          config,
          basePath: tempDir,
          sessionId: 'flush-session',
          systemPromptBuilder: () => 'Budgeted prompt',
          memoryProvider: undefined,
        },
      ),
    )
    agent.setConversationHistory(history)

    const result = await agent.run('Continue with the migration plan and preserve state.')

    expect(result.text).toContain('Checkpoint refreshed')
    const observations = readObservations('flush-session', tempDir)
    expect(observations.ok).toBe(true)
    if (observations.ok) {
      expect(observations.value.length).toBeGreaterThan(0)
    }

    const checkpoint = readCheckpoint('flush-session', tempDir)
    expect(checkpoint.ok).toBe(true)
    if (checkpoint.ok) {
      expect(checkpoint.value).not.toBeNull()
      expect(checkpoint.value?.openLoops.join('\n')).not.toContain(longMessage)
      expect(checkpoint.value?.openLoops.join('\n')).toContain('Continue with the migration plan')
    }

    expect(agent.getConversationHistory().length).toBeGreaterThan(config.memory.tailMessageCount)
  })

  test('does not advance observed state or compact history when observation writes fail', async () => {
    const invalidBasePath = join(tempDir, 'not-a-directory')
    writeFileSync(invalidBasePath, 'blocking file', 'utf-8')

    const config = configSchema.parse({
      memory: {
        contextWindowTokens: 300,
        warnRatio: 0.2,
        flushRatio: 0.25,
        compactRatio: 0.3,
        tailMessageCount: 1,
      },
    })

    const history = [
      { role: 'user' as const, content: 'Capture this task before compaction.' },
      { role: 'assistant' as const, content: 'I am tracking the current state.' },
      { role: 'user' as const, content: 'Do not lose the follow-up request.' },
    ]

    const agent = new Agent(
      makeAgentOptions(
        createMockModel([[...textBlock('Continued without compaction.'), finishStop()]]),
        registry,
        {
          config,
          basePath: invalidBasePath,
          sessionId: 'failed-observation-session',
          systemPromptBuilder: () => 'Budgeted prompt',
          memoryProvider: undefined,
        },
      ),
    )
    agent.setConversationHistory(history)

    await agent.run('Keep going even if observation persistence fails.')

    expect(agent.getConversationHistory()).toHaveLength(history.length + 2)
    expect((agent as unknown as { observedHistoryLength: number }).observedHistoryLength).toBe(0)
    expect(
      (agent as unknown as { checkpointedHistoryLength: number }).checkpointedHistoryLength,
    ).toBe(0)
    expect(
      existsSync(resolveObservationLogPath('failed-observation-session', invalidBasePath)),
    ).toBe(false)
    expect(existsSync(resolveCheckpointPath('failed-observation-session', invalidBasePath))).toBe(
      false,
    )
  })

  test('automatically retries once after a length stop using compacted checkpoint context', async () => {
    setupMemoryDir(tempDir, '# Durable Memory\n\n- Use checkpoint recovery')
    writeCheckpoint(
      {
        sessionId: 'length-session',
        updatedAt: '2026-04-15T12:00:00.000Z',
        goal: 'Complete the migration safely',
        currentPlan: ['Inspect current state', 'Apply the fix'],
        constraints: ['Do not lose active task state'],
        decisionsMade: ['Use checkpoint-backed compaction'],
        filesInPlay: ['packages/cli/src/agent.ts'],
        completedWork: ['Added layered memory'],
        openLoops: ['Finish the recovery flow'],
        nextBestStep: 'Retry with compacted context',
        durableMemoryCandidates: [],
        skillCandidates: [],
      },
      tempDir,
    )

    const config = configSchema.parse({
      memory: {
        contextWindowTokens: 1000,
        warnRatio: 0.8,
        flushRatio: 0.9,
        compactRatio: 0.95,
        tailMessageCount: 2,
        durableMemoryBudgetTokens: 200,
        checkpointBudgetTokens: 200,
        workingMemoryBudgetTokens: 200,
      },
    })

    let secondPrompt = ''
    const observedEvents: string[] = []
    const model = createInspectingMockModel((prompt, callIndex) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((message) => message.role === 'system')
      const systemText = String(
        Array.isArray(systemMsg?.content)
          ? (systemMsg?.content as Array<{ text?: string }>)
              .map((chunk) => chunk.text ?? '')
              .join('')
          : (systemMsg?.content ?? ''),
      )

      if (callIndex === 0) {
        return [
          ...textBlock('Partial answer before the model ran out of room.'),
          {
            type: 'finish',
            finishReason: { unified: 'length', raw: 'length' },
            usage: {
              inputTokens: {
                total: 50,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
          },
        ]
      }

      secondPrompt = systemText
      return [...textBlock('Recovered after compacting the history.'), finishStop()]
    })

    const agent = new Agent(
      makeAgentOptions(model, registry, {
        config,
        basePath: tempDir,
        sessionId: 'length-session',
        systemPromptBuilder: buildSystemPrompt,
        memoryProvider: undefined,
        onEvent: (event) => observedEvents.push(event.type),
      }),
    )
    agent.setConversationHistory([
      { role: 'user', content: 'Previous task context that should be compacted.' },
      { role: 'assistant', content: 'Acknowledged the previous task context.' },
      { role: 'user', content: 'Keep the active migration state intact.' },
      { role: 'assistant', content: 'Tracking the migration state.' },
    ])

    const result = await agent.run('Continue from the current migration checkpoint.')

    expect(result.text).toContain('Recovered after compacting')
    expect(secondPrompt).toContain('### Checkpoint Memory')
    expect(secondPrompt).toContain('Do not lose active task state')
    expect(secondPrompt).toContain('Retry with compacted context')
    expect(agent.getConversationHistory().length).toBeLessThanOrEqual(
      config.memory.tailMessageCount + 1,
    )
    expect(observedEvents).toContain('rsi-length-recovery-succeeded')

    const logEntries = getEntries({ limit: 20 }, tempDir)
    expect(logEntries.ok).toBe(true)
    if (logEntries.ok) {
      expect(logEntries.value.map((entry) => entry.type)).toContain('length-recovery-succeeded')
    }
  })

  test('preserves checkpoint state when compaction runs before the LLM call', async () => {
    setupMemoryDir(tempDir, '# Durable Memory\n\n- Protect continuity during compaction')
    writeCheckpoint(
      {
        sessionId: 'compact-session',
        updatedAt: '2026-04-15T13:00:00.000Z',
        goal: 'Finish the multi-step refactor',
        currentPlan: ['Audit state', 'Compact safely', 'Resume work'],
        constraints: ['Keep all constraints visible'],
        decisionsMade: ['Checkpoint is the recovery source'],
        filesInPlay: ['packages/cli/src/agent.ts', 'packages/cli/src/llm/prompt.ts'],
        completedWork: ['Built the checkpoint renderer'],
        openLoops: ['Resume after compaction'],
        nextBestStep: 'Continue from the compacted checkpoint',
        durableMemoryCandidates: [],
        skillCandidates: [],
      },
      tempDir,
    )

    const config = configSchema.parse({
      memory: {
        contextWindowTokens: 240,
        warnRatio: 0.2,
        flushRatio: 0.35,
        compactRatio: 0.45,
        tailMessageCount: 2,
        durableMemoryBudgetTokens: 200,
        checkpointBudgetTokens: 200,
        workingMemoryBudgetTokens: 200,
      },
    })

    const longLine =
      'Keep the active task state and constraints visible through compaction. '.repeat(12)
    let capturedPrompt = ''
    const model = createInspectingMockModel((prompt) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((message) => message.role === 'system')
      capturedPrompt = String(
        Array.isArray(systemMsg?.content)
          ? (systemMsg?.content as Array<{ text?: string }>)
              .map((chunk) => chunk.text ?? '')
              .join('')
          : (systemMsg?.content ?? ''),
      )
      return [...textBlock('State preserved after compaction.'), finishStop()]
    })

    const agent = new Agent(
      makeAgentOptions(model, registry, {
        config,
        basePath: tempDir,
        sessionId: 'compact-session',
        systemPromptBuilder: buildSystemPrompt,
        memoryProvider: undefined,
      }),
    )
    agent.setConversationHistory([
      { role: 'user', content: longLine },
      { role: 'assistant', content: 'State recorded.' },
      { role: 'user', content: longLine },
      { role: 'assistant', content: 'Still tracking the state.' },
    ])

    const result = await agent.run('Continue the refactor after compaction.')

    expect(result.text).toContain('State preserved')
    expect(capturedPrompt).toContain('Keep all constraints visible')
    expect(capturedPrompt).toContain('Built the checkpoint renderer')
    expect(capturedPrompt).toContain('Resume after compaction')
    expect(capturedPrompt).toContain('Continue from the compacted checkpoint')
    expect(agent.getConversationHistory().length).toBeLessThanOrEqual(
      config.memory.tailMessageCount + 1,
    )
  })

  test('emits and persists compaction lifecycle events', async () => {
    setupMemoryDir(tempDir, '# Durable Memory\n\n- Track compaction events')

    const config = configSchema.parse({
      memory: {
        contextWindowTokens: 220,
        warnRatio: 0.2,
        flushRatio: 0.25,
        compactRatio: 0.35,
        tailMessageCount: 2,
      },
    })

    const observedEvents: string[] = []
    const longLine = 'Keep the active task state intact while context is compacted. '.repeat(12)
    const agent = new Agent(
      makeAgentOptions(
        createMockModel([[...textBlock('Compaction lifecycle captured.'), finishStop()]]),
        registry,
        {
          config,
          basePath: tempDir,
          sessionId: 'metrics-session',
          systemPromptBuilder: buildSystemPrompt,
          memoryProvider: undefined,
          onEvent: (event) => observedEvents.push(event.type),
        },
      ),
    )
    agent.setConversationHistory([
      { role: 'user', content: longLine },
      { role: 'assistant', content: 'State recorded.' },
      { role: 'user', content: longLine },
      { role: 'assistant', content: 'More state recorded.' },
    ])

    await agent.run('Continue while preserving checkpoint state.')

    expect(observedEvents).toContain('rsi-context-flushed')
    expect(observedEvents).toContain('rsi-observation-recorded')
    expect(observedEvents).toContain('rsi-checkpoint-written')
    expect(observedEvents).toContain('rsi-history-compacted')

    const logEntries = getEntries({ limit: 10 }, tempDir)
    expect(logEntries.ok).toBe(true)
    if (!logEntries.ok) return

    const entryTypes = logEntries.value.map((entry) => entry.type)
    expect(entryTypes).toContain('context-flushed')
    expect(entryTypes).toContain('observation-recorded')
    expect(entryTypes).toContain('checkpoint-written')
    expect(entryTypes).toContain('history-compacted')
  })

  // -------------------------------------------------------------------
  // Test: Agent can use the memory tool to read/write topics
  // -------------------------------------------------------------------
  test('agent can use memory tool to write and read topics during a task', async () => {
    setupMemoryDir(tempDir)

    // Create a memory tool with the temp directory as basePath
    const memoryExecute = createMemoryExecute({ basePath: tempDir })
    registry.register({
      name: 'memory',
      description: 'Memory operations',
      schema: z.object({
        action: z.string(),
        name: z.string().optional(),
        content: z.string().optional(),
      }),
      execute: async (args) => {
        const input = args as { action: string; name?: string; content?: string }
        return memoryExecute({
          action: input.action as 'write-topic' | 'read-topic' | 'read-index',
          name: input.name,
          content: input.content,
        })
      },
    })

    const model = createMockModel([
      // Turn 1: LLM writes a topic
      [
        ...toolCallBlock('call_write', 'memory', {
          action: 'write-topic',
          name: 'test-topic',
          content: 'Important: the sky is blue',
        }),
        finishToolCalls(),
      ],
      // Turn 2: LLM reads it back
      [
        ...toolCallBlock('call_read', 'memory', {
          action: 'read-topic',
          name: 'test-topic',
        }),
        finishToolCalls(),
      ],
      // Turn 3: Final response
      [...textBlock('I stored and retrieved the information. The sky is blue.'), finishStop()],
    ])

    const agent = new Agent(makeAgentOptions(model, registry))
    const result = await agent.run('Remember that the sky is blue')

    expect(result.text).toContain('sky is blue')
    expect(result.iterations).toBe(3)

    // Verify the topic was actually written to disk
    const topicResult = readTopic('test-topic', tempDir)
    expect(topicResult.ok).toBe(true)
    if (topicResult.ok) {
      expect(topicResult.value).toBe('Important: the sky is blue')
    }
  })

  // -------------------------------------------------------------------
  // Test: Session transcripts are stored in SQLite after conversation
  // -------------------------------------------------------------------
  test('session transcripts are stored in SQLite after agent conversation', async () => {
    const dbPath = join(tempDir, 'transcripts.db')
    const store = new TranscriptStore(dbPath)

    try {
      // Create a session
      const sessionResult = store.createSession()
      expect(sessionResult.ok).toBe(true)
      if (!sessionResult.ok) return
      const sessionId = sessionResult.value

      // Run an agent conversation
      const model = createMockModel([
        [...textBlock('Hello! How can I help you today?'), finishStop()],
      ])

      const agent = new Agent(makeAgentOptions(model, registry))
      await agent.run('Hi there')

      // Store the conversation in the transcript
      const history = agent.getConversationHistory()
      for (const msg of history) {
        if (msg.role === 'user') {
          store.addMessage(sessionId, { role: 'user', content: llmUserContentToText(msg.content) })
        } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
          store.addMessage(sessionId, { role: 'assistant', content: msg.content })
        }
      }

      // End the session
      store.endSession(sessionId, 'Test session')

      // Verify the session exists with messages
      const session = store.getSession(sessionId)
      expect(session.ok).toBe(true)
      if (!session.ok) return

      expect(session.value.messages).toHaveLength(2) // user + assistant
      expect(session.value.messages[0].role).toBe('user')
      expect(session.value.messages[0].content).toBe('Hi there')
      expect(session.value.messages[1].role).toBe('assistant')
      expect(session.value.messages[1].content).toBe('Hello! How can I help you today?')
      expect(session.value.endedAt).not.toBeNull()
      expect(session.value.summary).toBe('Test session')
    } finally {
      store.close()
    }
  })

  // -------------------------------------------------------------------
  // Test: Multi-turn conversation with tool calls stored in transcript
  // -------------------------------------------------------------------
  test('multi-turn conversation with tool calls stored in transcript', async () => {
    const dbPath = join(tempDir, 'transcripts-multi.db')
    const store = new TranscriptStore(dbPath)

    try {
      registry.register({
        name: 'bash',
        description: 'Run command',
        schema: z.object({ command: z.string().optional() }),
        execute: async () => ok({ stdout: 'result', stderr: '', exitCode: 0 }),
      })

      const model = createMockModel([
        // Turn 1: Tool call
        [...toolCallBlock('call_1', 'bash', { command: 'ls' }), finishToolCalls()],
        // Turn 2: Final text
        [...textBlock('Here are the files.'), finishStop()],
      ])

      const agent = new Agent(makeAgentOptions(model, registry))
      await agent.run('List files')

      // Create session and store all messages
      const sessionResult = store.createSession()
      expect(sessionResult.ok).toBe(true)
      if (!sessionResult.ok) return
      const sessionId = sessionResult.value

      const history = agent.getConversationHistory()
      for (const msg of history) {
        if (msg.role === 'user') {
          store.addMessage(sessionId, { role: 'user', content: llmUserContentToText(msg.content) })
        } else if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            store.addMessage(sessionId, {
              role: 'tool-call',
              content: `${tc.toolName}: ${JSON.stringify(tc.input)}`,
              toolName: tc.toolName,
              toolArgs: tc.input,
            })
          }
        } else if (msg.role === 'assistant') {
          store.addMessage(sessionId, { role: 'assistant', content: msg.content })
        } else if (msg.role === 'tool') {
          for (const tr of msg.content) {
            store.addMessage(sessionId, {
              role: 'tool-result',
              content: JSON.stringify(tr.result),
              toolName: tr.toolName,
            })
          }
        }
      }

      store.endSession(sessionId)

      // Verify messages are stored in order
      const session = store.getSession(sessionId)
      expect(session.ok).toBe(true)
      if (!session.ok) return

      expect(session.value.messages.length).toBeGreaterThanOrEqual(3)

      // First message should be the user message
      expect(session.value.messages[0].role).toBe('user')
      expect(session.value.messages[0].content).toBe('List files')

      // Should have tool-call and tool-result messages
      const toolCallMsgs = session.value.messages.filter((m) => m.role === 'tool-call')
      expect(toolCallMsgs.length).toBeGreaterThanOrEqual(1)
      expect(toolCallMsgs[0].toolName).toBe('bash')

      const toolResultMsgs = session.value.messages.filter((m) => m.role === 'tool-result')
      expect(toolResultMsgs.length).toBeGreaterThanOrEqual(1)
    } finally {
      store.close()
    }
  })
})
