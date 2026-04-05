/**
 * End-to-End Smoke Test
 *
 * A single comprehensive test that runs a multi-step task through the
 * full agent loop:
 *
 * 1. Agent receives task: "Create a file called hello.txt with content
 *    'Hello from Ouroboros', then read it back and tell me what it contains"
 * 2. Mock LLM scripted to:
 *    a) Call file-write tool
 *    b) Call file-read tool
 *    c) Return summary text
 * 3. Verifies:
 *    - File exists on disk with correct content
 *    - Agent response mentions the content
 *    - Session transcript is stored in SQLite
 *
 * Uses a mock LLM (no real API calls) for speed and determinism.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import type { ToolDefinition } from '@src/tools/types'
import { TranscriptStore } from '@src/memory/transcripts'
import * as fileWriteTool from '@src/tools/file-write'
import * as fileReadTool from '@src/tools/file-read'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMockModel,
  textDelta,
  toolCall,
  finishStop,
  finishToolCalls,
} from '../helpers/mock-llm'
import { makeTempDir, cleanupTempDir, collectEvents, makeAgentOptions } from '../helpers/test-utils'

describe('E2E Smoke Test', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-e2e-smoke')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  // -------------------------------------------------------------------
  // Test: E2E smoke -- file create and read
  // -------------------------------------------------------------------
  test('full agent loop: create file, read it back, verify on disk and in transcript', async () => {
    const filePath = join(tempDir, 'hello.txt')
    const fileContent = 'Hello from Ouroboros'
    const dbPath = join(tempDir, 'e2e-transcripts.db')

    // ── Set up tools ──────────────────────────────────────────────
    const registry = new ToolRegistry()

    // Register real file-write and file-read tools
    registry.register(fileWriteTool as ToolDefinition)
    registry.register(fileReadTool as ToolDefinition)

    // ── Set up mock LLM with scripted responses ──────────────────
    const model = createMockModel([
      // Step 1: LLM calls file-write
      [
        toolCall('call_write', 'file-write', {
          path: filePath,
          content: fileContent,
        }),
        finishToolCalls(),
      ],
      // Step 2: LLM calls file-read after write succeeds
      [
        toolCall('call_read', 'file-read', {
          path: filePath,
        }),
        finishToolCalls(),
      ],
      // Step 3: LLM produces final summary text
      [
        textDelta("I created the file hello.txt with the content 'Hello from Ouroboros'. "),
        textDelta('After reading it back, I can confirm the file contains: Hello from Ouroboros'),
        finishStop(),
      ],
    ])

    // ── Run the agent ────────────────────────────────────────────
    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const task =
      "Create a file called hello.txt with the content 'Hello from Ouroboros', then read it back and tell me what it contains"
    const result = await agent.run(task)

    // ── Verify 1: File exists on disk with correct content ──────
    expect(existsSync(filePath)).toBe(true)
    const diskContent = readFileSync(filePath, 'utf-8')
    expect(diskContent).toBe(fileContent)

    // ── Verify 2: Agent response mentions the content ───────────
    expect(result.text).toContain('Hello from Ouroboros')
    expect(result.iterations).toBe(3) // write, read, summary

    // ── Verify 3: Tool events were emitted correctly ────────────
    const toolStarts = events.filter((e) => e.type === 'tool-call-start')
    expect(toolStarts).toHaveLength(2)
    if (toolStarts[0]?.type === 'tool-call-start') {
      expect(toolStarts[0].toolName).toBe('file-write')
    }
    if (toolStarts[1]?.type === 'tool-call-start') {
      expect(toolStarts[1].toolName).toBe('file-read')
    }

    const toolEnds = events.filter((e) => e.type === 'tool-call-end')
    expect(toolEnds).toHaveLength(2)
    for (const te of toolEnds) {
      if (te.type === 'tool-call-end') {
        expect(te.isError).toBe(false)
      }
    }

    // ── Verify 4: Conversation history is complete ──────────────
    const history = agent.getConversationHistory()

    // Should have: user, assistant(tool-call), tool(result), assistant(tool-call), tool(result), assistant(text)
    expect(history.length).toBeGreaterThanOrEqual(5)

    // First message is the user task
    expect(history[0].role).toBe('user')
    expect(history[0]).toHaveProperty('content', task)

    // Final message is the assistant response
    const lastMsg = history[history.length - 1]
    expect(lastMsg.role).toBe('assistant')
    if (lastMsg.role === 'assistant') {
      expect(lastMsg.content).toContain('Hello from Ouroboros')
    }

    // ── Verify 5: Session transcript stored in SQLite ───────────
    const store = new TranscriptStore(dbPath)
    try {
      const sessionResult = store.createSession()
      expect(sessionResult.ok).toBe(true)
      if (!sessionResult.ok) return
      const sessionId = sessionResult.value

      // Store the full conversation in the transcript
      for (const msg of history) {
        if (msg.role === 'user') {
          store.addMessage(sessionId, { role: 'user', content: msg.content })
        } else if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
          // Assistant message with tool calls
          const toolCallText = msg.toolCalls
            .map((tc) => `${tc.toolName}(${JSON.stringify(tc.input)})`)
            .join(', ')
          store.addMessage(sessionId, {
            role: 'tool-call',
            content: toolCallText,
            toolName: msg.toolCalls[0].toolName,
            toolArgs: msg.toolCalls[0].input,
          })
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

      store.endSession(sessionId, 'E2E smoke test: file create and read')

      // Verify session was stored
      const session = store.getSession(sessionId)
      expect(session.ok).toBe(true)
      if (!session.ok) return

      // Should have multiple messages stored
      expect(session.value.messages.length).toBeGreaterThanOrEqual(4)

      // First stored message should be the user task
      expect(session.value.messages[0].role).toBe('user')
      expect(session.value.messages[0].content).toContain('hello.txt')

      // Should have tool-call and tool-result messages
      const hasToolCall = session.value.messages.some((m) => m.role === 'tool-call')
      expect(hasToolCall).toBe(true)

      const hasToolResult = session.value.messages.some((m) => m.role === 'tool-result')
      expect(hasToolResult).toBe(true)

      // Last message should be the assistant summary
      const lastStored = session.value.messages[session.value.messages.length - 1]
      expect(lastStored.role).toBe('assistant')
      expect(lastStored.content).toContain('Hello from Ouroboros')

      // Session should be marked as ended
      expect(session.value.endedAt).not.toBeNull()
      expect(session.value.summary).toBe('E2E smoke test: file create and read')

      // Search should find the content
      const searchResult = store.searchTranscripts('Hello from Ouroboros')
      expect(searchResult.ok).toBe(true)
      if (!searchResult.ok) return
      expect(searchResult.value.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  // -------------------------------------------------------------------
  // Test: E2E smoke -- multi-turn conversation maintains state
  // -------------------------------------------------------------------
  test('multi-turn conversation: agent remembers context across runs', async () => {
    const registry = new ToolRegistry()

    // Turn 1: Simple text response
    // Turn 2: Another text response that references turn 1
    const model = createMockModel([
      // Turn 1
      [textDelta('I understand. You want me to call you Alice.'), finishStop()],
      // Turn 2
      [textDelta('Your name is Alice, as you told me earlier.'), finishStop()],
    ])

    const agent = new Agent(makeAgentOptions(model, registry))

    // First turn
    const result1 = await agent.run('My name is Alice')
    expect(result1.text).toContain('Alice')

    // Second turn - agent should have history
    const result2 = await agent.run("What's my name?")
    expect(result2.text).toContain('Alice')

    // Verify conversation history has all 4 messages
    const history = agent.getConversationHistory()
    expect(history).toHaveLength(4)
    expect(history[0].role).toBe('user')
    expect(history[1].role).toBe('assistant')
    expect(history[2].role).toBe('user')
    expect(history[3].role).toBe('assistant')
  })

  // -------------------------------------------------------------------
  // Test: E2E smoke -- error recovery during multi-step task
  // -------------------------------------------------------------------
  test('agent recovers from tool error during multi-step task', async () => {
    const filePath = join(tempDir, 'recovery-test.txt')

    const registry = new ToolRegistry()
    registry.register(fileWriteTool as ToolDefinition)
    registry.register(fileReadTool as ToolDefinition)

    const model = createMockModel([
      // Step 1: LLM tries to read a non-existent file
      [
        toolCall('call_read_bad', 'file-read', { path: join(tempDir, 'nonexistent.txt') }),
        finishToolCalls(),
      ],
      // Step 2: LLM sees the error and writes the file instead
      [
        toolCall('call_write', 'file-write', {
          path: filePath,
          content: 'Recovery content',
        }),
        finishToolCalls(),
      ],
      // Step 3: Final response
      [textDelta('The file did not exist, so I created it with recovery content.'), finishStop()],
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))
    const result = await agent.run('Read recovery-test.txt or create it')

    expect(result.text).toContain('recovery content')
    expect(result.iterations).toBe(3)

    // The first tool call should have resulted in an error
    const toolEnds = events.filter((e) => e.type === 'tool-call-end')
    expect(toolEnds).toHaveLength(2)
    if (toolEnds[0]?.type === 'tool-call-end') {
      expect(toolEnds[0].isError).toBe(true) // file-read fails
    }
    if (toolEnds[1]?.type === 'tool-call-end') {
      expect(toolEnds[1].isError).toBe(false) // file-write succeeds
    }

    // The file should exist after recovery
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('Recovery content')
  })
})
