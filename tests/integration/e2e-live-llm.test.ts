/**
 * E2E Integration Tests with Real LLM Calls
 *
 * These tests make actual API calls to OpenAI using gpt-5.4 to verify
 * the full agent loop works end-to-end with real tool execution.
 *
 * Requirements:
 *   - OPENAI_API_KEY must be set (via .env or environment)
 *
 * Run separately from unit tests:
 *   bun run test:live
 *
 * Skips automatically if no API key is present (CI-safe).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import type { ToolDefinition } from '@src/tools/types'
import { createProvider } from '@src/llm/provider'
import * as bashTool from '@src/tools/bash'
import * as fileReadTool from '@src/tools/file-read'
import * as fileWriteTool from '@src/tools/file-write'
import * as fileEditTool from '@src/tools/file-edit'
import * as webFetchTool from '@src/tools/web-fetch'
import * as webSearchTool from '@src/tools/web-search'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, cleanupTempDir, collectEvents } from '../helpers/test-utils'
import type { LanguageModel } from 'ai'

// ── Configuration ────────────────────────────────────────────────────

const MODEL_NAME = 'gpt-5.4'
const MAX_ITERATIONS = 15
const TEST_TIMEOUT = 60_000 // 60s per test

const HAS_API_KEY = !!process.env.OPENAI_API_KEY

// ── Helpers ──────────────────────────────────────────────────────────

function createLiveModel(): LanguageModel {
  const result = createProvider({ provider: 'openai', name: MODEL_NAME })
  if (!result.ok) throw new Error(`Failed to create model: ${result.error.message}`)
  return result.value
}

function createLiveAgent(
  tools: Array<{ name: string; description: string; schema: unknown; execute: Function }>,
  overrides?: { maxIterations?: number },
) {
  const registry = new ToolRegistry()
  for (const tool of tools) {
    registry.register(tool as ToolDefinition)
  }

  const model = createLiveModel()
  const collected = collectEvents()

  const agent = new Agent({
    model,
    toolRegistry: registry,
    maxIterations: overrides?.maxIterations ?? MAX_ITERATIONS,
    onEvent: collected.handler,
    systemPromptBuilder: () =>
      'You are a helpful assistant. Use tools to accomplish tasks. Be concise in your responses.',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
  })

  return { agent, events: collected.events }
}

// ── Tests ────────────────────────────────────────────────────────────

describe.skipIf(!HAS_API_KEY)('E2E Live LLM Tests (gpt-5.4)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-live-e2e')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  // -------------------------------------------------------------------
  // Test 1: Bash tool
  // -------------------------------------------------------------------
  test(
    'bash tool: executes a shell command and returns output',
    async () => {
      const { agent, events } = createLiveAgent([bashTool])

      const result = await agent.run(
        "Use the bash tool to run the command: echo 'hello-ouroboros-live-test' — then tell me exactly what the output was.",
      )

      // The agent should have used the bash tool
      const toolStarts = events.filter((e) => e.type === 'tool-call-start')
      expect(toolStarts.length).toBeGreaterThanOrEqual(1)
      const bashCall = toolStarts.find((e) => e.type === 'tool-call-start' && e.toolName === 'bash')
      expect(bashCall).toBeDefined()

      // The response should contain the command output
      expect(result.text).toContain('hello-ouroboros-live-test')
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 2: File write + read
  // -------------------------------------------------------------------
  test(
    'file tools: creates a file and reads it back',
    async () => {
      const { agent } = createLiveAgent([fileWriteTool, fileReadTool])
      const filePath = join(tempDir, 'live-test.txt')

      const result = await agent.run(
        `Create a file at ${filePath} with the content "Live LLM integration test", then read it back and tell me what it contains.`,
      )

      // File should exist on disk
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf-8')).toBe('Live LLM integration test')

      // Agent response should reference the content
      expect(result.text.toLowerCase()).toContain('live llm integration test')
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 3: File edit
  // -------------------------------------------------------------------
  test(
    'file-edit tool: modifies an existing file',
    async () => {
      const filePath = join(tempDir, 'edit-target.txt')
      writeFileSync(filePath, 'The quick brown fox jumps over the lazy dog.')

      const { agent } = createLiveAgent([fileReadTool, fileEditTool])

      await agent.run(
        `Read the file at ${filePath}, then edit it to replace "lazy dog" with "energetic cat".`,
      )

      // File on disk should have the replacement
      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('energetic cat')
      expect(content).not.toContain('lazy dog')
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 4: Web fetch
  // -------------------------------------------------------------------
  test(
    'web-fetch tool: fetches a URL and extracts content',
    async () => {
      const { agent, events } = createLiveAgent([webFetchTool])

      const result = await agent.run(
        'Use the web-fetch tool to fetch https://httpbin.org/html and tell me the title or subject of the page content.',
      )

      // Should have called web-fetch
      const toolStarts = events.filter(
        (e) => e.type === 'tool-call-start' && e.toolName === 'web-fetch',
      )
      expect(toolStarts.length).toBeGreaterThanOrEqual(1)

      // httpbin.org/html returns a page about Herman Melville
      expect(result.text.toLowerCase()).toMatch(/melville|moby|herman/i)
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 5: Web search
  // -------------------------------------------------------------------
  test(
    'web-search tool: searches the web and returns results',
    async () => {
      const { agent, events } = createLiveAgent([webSearchTool])

      const result = await agent.run(
        'Use the web-search tool to search for "TypeScript bun runtime" and summarize what Bun is in one sentence.',
      )

      // Should have called web-search
      const toolStarts = events.filter(
        (e) => e.type === 'tool-call-start' && e.toolName === 'web-search',
      )
      expect(toolStarts.length).toBeGreaterThanOrEqual(1)

      // Response should be substantive
      expect(result.text.length).toBeGreaterThan(20)
      // Should mention something related to Bun/JavaScript/TypeScript
      expect(result.text.toLowerCase()).toMatch(/bun|javascript|typescript|runtime/i)
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 6: Multi-tool chain
  // -------------------------------------------------------------------
  test(
    'multi-tool chain: bash + file-write + file-read in sequence',
    async () => {
      const { agent, events } = createLiveAgent([bashTool, fileWriteTool, fileReadTool])
      const filePath = join(tempDir, 'chain-test.txt')

      const result = await agent.run(
        `Use bash to run "date +%Y-%m-%d" to get today's date, then write the result to ${filePath}, then read the file back and confirm the contents.`,
      )

      // File should exist with a date-like string
      expect(existsSync(filePath)).toBe(true)
      const content = readFileSync(filePath, 'utf-8').trim()
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}/)

      // Should have used multiple tools
      const toolStarts = events.filter((e) => e.type === 'tool-call-start')
      expect(toolStarts.length).toBeGreaterThanOrEqual(2)

      // Agent should mention the date
      expect(result.text).toMatch(/\d{4}/)
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 7: Multi-turn conversation with tools
  // -------------------------------------------------------------------
  test(
    'multi-turn: agent maintains context across runs with tool use',
    async () => {
      const { agent } = createLiveAgent([bashTool, fileWriteTool, fileReadTool])
      const filePath = join(tempDir, 'multi-turn.txt')

      // Turn 1: Create a file
      await agent.run(`Write the text "session-alpha" to ${filePath}`)
      expect(existsSync(filePath)).toBe(true)

      // Turn 2: Ask about what we did — agent should remember
      const result2 = await agent.run(
        'What file did I just ask you to create, and what was the content? Also read it back to confirm.',
      )

      expect(result2.text.toLowerCase()).toContain('session-alpha')
    },
    TEST_TIMEOUT,
  )

  // -------------------------------------------------------------------
  // Test 8: Error recovery
  // -------------------------------------------------------------------
  test(
    'error recovery: agent handles tool failure and adapts',
    async () => {
      const { agent, events } = createLiveAgent([fileReadTool, fileWriteTool])
      const missingPath = join(tempDir, 'does-not-exist.txt')
      const recoveryPath = join(tempDir, 'recovered.txt')

      await agent.run(
        `Try to read the file at ${missingPath}. It won't exist — that's expected. When you get the error, create a new file at ${recoveryPath} with the content "recovered successfully" instead.`,
      )

      // The recovery file should exist
      expect(existsSync(recoveryPath)).toBe(true)
      expect(readFileSync(recoveryPath, 'utf-8')).toBe('recovered successfully')

      // Should have had at least one error and one success
      const toolEnds = events.filter((e) => e.type === 'tool-call-end')
      const hasError = toolEnds.some((e) => e.type === 'tool-call-end' && e.isError)
      const hasSuccess = toolEnds.some((e) => e.type === 'tool-call-end' && !e.isError)
      expect(hasError).toBe(true)
      expect(hasSuccess).toBe(true)
    },
    TEST_TIMEOUT,
  )
})
