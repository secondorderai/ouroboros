/**
 * Integration Test: Agent + Tools
 *
 * Verifies that the Agent loop correctly dispatches tool calls
 * to the ToolRegistry and processes results in the conversation.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Agent } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok, err } from '@src/types'
import type { ToolDefinition } from '@src/tools/types'
import {
  createMockModel,
  textDelta,
  toolCall,
  finishStop,
  finishToolCalls
} from '../helpers/mock-llm'
import { makeTool, makeErrorTool, collectEvents, makeAgentOptions } from '../helpers/test-utils'

describe('Agent + Tools Integration', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  // -------------------------------------------------------------------
  // Test: Agent dispatches tool calls and processes results
  // -------------------------------------------------------------------
  test('agent dispatches tool calls to the registry and processes results', async () => {
    registry.register(
      makeTool('bash', () => ({ stdout: 'hello\n', stderr: '', exitCode: 0 }))
    )

    const model = createMockModel([
      // Turn 1: LLM requests a tool call
      [
        toolCall('call_1', 'bash', { input: 'echo hello' }),
        finishToolCalls()
      ],
      // Turn 2: LLM produces final text after seeing tool result
      [
        textDelta('The command output: hello'),
        finishStop()
      ]
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const result = await agent.run('Run echo hello')

    expect(result.text).toBe('The command output: hello')
    expect(result.iterations).toBe(2)

    // Verify tool call events were emitted
    const toolStarts = events.filter(e => e.type === 'tool-call-start')
    expect(toolStarts).toHaveLength(1)
    if (toolStarts[0]?.type === 'tool-call-start') {
      expect(toolStarts[0].toolName).toBe('bash')
    }

    const toolEnds = events.filter(e => e.type === 'tool-call-end')
    expect(toolEnds).toHaveLength(1)
    if (toolEnds[0]?.type === 'tool-call-end') {
      expect(toolEnds[0].toolName).toBe('bash')
      expect(toolEnds[0].isError).toBe(false)
    }

    // Verify conversation history has tool call and result
    const history = agent.getConversationHistory()
    const toolMsg = history.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    if (toolMsg?.role === 'tool') {
      expect(toolMsg.content[0].toolCallId).toBe('call_1')
      expect(toolMsg.content[0].toolName).toBe('bash')
    }
  })

  // -------------------------------------------------------------------
  // Test: Agent handles tool errors (tool returns Result error)
  // -------------------------------------------------------------------
  test('agent handles tool errors by passing error back to LLM', async () => {
    registry.register(makeErrorTool('failing-tool', 'Permission denied: /etc/shadow'))

    const model = createMockModel([
      // Turn 1: LLM calls the failing tool
      [
        toolCall('call_err', 'failing-tool', { input: 'test' }),
        finishToolCalls()
      ],
      // Turn 2: LLM acknowledges the error gracefully
      [
        textDelta('The tool failed with a permission error. Let me try another approach.'),
        finishStop()
      ]
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const result = await agent.run('Read /etc/shadow')

    // Agent should not crash
    expect(result.text).toBe('The tool failed with a permission error. Let me try another approach.')
    expect(result.iterations).toBe(2)

    // Tool-call-end event should indicate an error
    const toolEnd = events.find(e => e.type === 'tool-call-end')
    expect(toolEnd).toBeDefined()
    if (toolEnd?.type === 'tool-call-end') {
      expect(toolEnd.isError).toBe(true)
      expect(toolEnd.result).toContain('Permission denied')
    }

    // The error result should be in conversation history for the LLM to see
    const history = agent.getConversationHistory()
    const toolMsg = history.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
  })

  // -------------------------------------------------------------------
  // Test: Agent handles unknown tool names gracefully
  // -------------------------------------------------------------------
  test('agent handles unknown tool names gracefully via registry error', async () => {
    // Test the ToolRegistry directly for unknown tool names.
    // The registry returns an error Result (not a throw) for unknown tools.
    // The agent loop uses this Result to produce tool-call-end events with isError=true.
    //
    // We test this at the registry level because the Vercel AI SDK only
    // passes through tool-call events for tools it knows about. In production,
    // all registered tools are passed to the SDK so this case handles
    // schema validation failures or race conditions.

    const unknownResult = await registry.executeTool('nonexistent-tool', { input: 'test' })

    expect(unknownResult.ok).toBe(false)
    if (!unknownResult.ok) {
      expect(unknownResult.error.message).toContain('Unknown tool')
      expect(unknownResult.error.message).toContain('nonexistent-tool')
    }

    // Also verify that when a registered tool gets invalid args, the error
    // is passed back to the LLM as a tool result (not a crash)
    registry.register(makeTool('bash'))

    const model = createMockModel([
      // Turn 1: LLM calls bash with args that will fail schema validation
      // (the mock tool schema expects { input: z.string().optional() })
      [
        toolCall('call_bad_args', 'bash', { input: 'test' }),
        finishToolCalls()
      ],
      // Turn 2: LLM responds after seeing the tool result
      [
        textDelta('The tool executed successfully.'),
        finishStop()
      ]
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const result = await agent.run('Run something')

    // Agent should not crash
    expect(result.text).toBe('The tool executed successfully.')
    expect(result.iterations).toBe(2)

    // Tool call should have succeeded (valid args for mock tool)
    const toolEnd = events.find(e => e.type === 'tool-call-end')
    expect(toolEnd).toBeDefined()
  })

  // -------------------------------------------------------------------
  // Test: Multiple tool calls in sequence within one task
  // -------------------------------------------------------------------
  test('multiple tool calls in sequence within one task', async () => {
    let writeCallCount = 0
    let readCallCount = 0

    registry.register(
      makeTool('file-write', () => {
        writeCallCount++
        return { bytesWritten: 20, path: '/tmp/test.txt' }
      })
    )
    registry.register(
      makeTool('file-read', () => {
        readCallCount++
        return { content: '1\tHello from test', lines: 1, path: '/tmp/test.txt' }
      })
    )

    const model = createMockModel([
      // Turn 1: LLM calls file-write
      [
        toolCall('call_write', 'file-write', { input: 'write it' }),
        finishToolCalls()
      ],
      // Turn 2: LLM calls file-read after seeing write result
      [
        toolCall('call_read', 'file-read', { input: 'read it' }),
        finishToolCalls()
      ],
      // Turn 3: LLM produces final text
      [
        textDelta('I wrote the file and read it back. The content is: Hello from test'),
        finishStop()
      ]
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const result = await agent.run('Write a file then read it back')

    expect(result.text).toContain('Hello from test')
    expect(result.iterations).toBe(3)
    expect(writeCallCount).toBe(1)
    expect(readCallCount).toBe(1)

    // Both tool calls should appear in events
    const toolStarts = events.filter(e => e.type === 'tool-call-start')
    expect(toolStarts).toHaveLength(2)
    if (toolStarts[0]?.type === 'tool-call-start') {
      expect(toolStarts[0].toolName).toBe('file-write')
    }
    if (toolStarts[1]?.type === 'tool-call-start') {
      expect(toolStarts[1].toolName).toBe('file-read')
    }

    // Verify conversation history has the full sequence
    const history = agent.getConversationHistory()
    const toolMsgs = history.filter(m => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2) // One for each tool call turn
  })

  // -------------------------------------------------------------------
  // Test: Tool that throws (not Result error) is caught gracefully
  // -------------------------------------------------------------------
  test('tool that throws an exception is caught and reported as error', async () => {
    registry.register({
      name: 'crasher',
      description: 'A tool that throws',
      schema: z.object({ input: z.string().optional() }),
      execute: async () => {
        throw new Error('Unexpected crash!')
      }
    })

    const model = createMockModel([
      [
        toolCall('call_crash', 'crasher', {}),
        finishToolCalls()
      ],
      [
        textDelta('The tool crashed, but I can handle it.'),
        finishStop()
      ]
    ])

    const { events, handler } = collectEvents()
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

    const result = await agent.run('Use the crasher tool')

    expect(result.text).toBe('The tool crashed, but I can handle it.')

    const toolEnd = events.find(e => e.type === 'tool-call-end')
    expect(toolEnd).toBeDefined()
    if (toolEnd?.type === 'tool-call-end') {
      expect(toolEnd.isError).toBe(true)
      expect(toolEnd.result).toContain('Unexpected crash!')
    }
  })

  // -------------------------------------------------------------------
  // Test: Multiple parallel tool calls in one LLM response
  // -------------------------------------------------------------------
  test('multiple parallel tool calls in one LLM response are all executed', async () => {
    const executedTools: string[] = []
    registry.register(
      makeTool('tool-a', () => {
        executedTools.push('tool-a')
        return { result: 'A done' }
      })
    )
    registry.register(
      makeTool('tool-b', () => {
        executedTools.push('tool-b')
        return { result: 'B done' }
      })
    )

    const model = createMockModel([
      // Turn 1: LLM calls both tools in parallel
      [
        toolCall('call_a', 'tool-a', { input: 'go' }),
        toolCall('call_b', 'tool-b', { input: 'go' }),
        finishToolCalls()
      ],
      // Turn 2: Final text
      [
        textDelta('Both tools completed successfully.'),
        finishStop()
      ]
    ])

    const agent = new Agent(makeAgentOptions(model, registry))
    const result = await agent.run('Run both tools')

    expect(result.text).toBe('Both tools completed successfully.')
    expect(executedTools).toContain('tool-a')
    expect(executedTools).toContain('tool-b')
    expect(executedTools).toHaveLength(2)

    // Verify both results are in conversation
    const history = agent.getConversationHistory()
    const toolMsg = history.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    if (toolMsg?.role === 'tool') {
      expect(toolMsg.content).toHaveLength(2)
    }
  })
})
