/**
 * Integration Test: Agent + Memory
 *
 * Verifies that the Agent's system prompt includes MEMORY.md content,
 * the agent can use the memory tool during a task, and session
 * transcripts are stored in SQLite.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { TranscriptStore } from '@src/memory/transcripts'
import { getMemoryIndex } from '@src/memory/index'
import { readTopic } from '@src/memory/topics'
import { createExecute as createMemoryExecute } from '@src/tools/memory'
import { buildSystemPrompt } from '@src/llm/prompt'
import { z } from 'zod'
import { ok } from '@src/types'
import { join } from 'node:path'
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
          store.addMessage(sessionId, { role: 'user', content: msg.content })
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
          store.addMessage(sessionId, { role: 'user', content: msg.content })
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
