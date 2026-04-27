import { describe, test, expect, beforeEach } from 'bun:test'
import {
  ToolRegistry,
  createReadOnlyToolRegistry,
  createTestToolRegistry,
  createWorkerToolRegistry,
} from '@src/tools/registry'
import { z } from 'zod'
import { ok } from '@src/types'
import type { ToolDefinition } from '@src/tools/types'
import { resolve } from 'node:path'

/** Helper: create a minimal valid tool definition. */
function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `A test tool called ${name}`,
    schema: z.object({ input: z.string() }),
    execute: async (args) => ok({ echo: (args as { input: string }).input }),
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  // -----------------------------------------------------------------------
  // Feature test: Registry discovers all tools
  // -----------------------------------------------------------------------
  test('discovers all tool files from src/tools/', async () => {
    const toolsDir = resolve(import.meta.dir, '../../src/tools')
    await registry.discover(toolsDir)

    const tools = registry.getTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toEqual([
      'apply_worker_diff',
      'ask-user',
      'bash',
      'code-exec',
      'create-artifact',
      'crystallize',
      'dream',
      'evolution',
      'file-edit',
      'file-read',
      'file-write',
      'memory',
      'reflect',
      'self-test',
      'skill-gen',
      'skill-manager',
      'spawn_agent',
      'team_advisor',
      'team_graph',
      'todo',
      'web-fetch',
      'web-search',
    ])
    expect(registry.size).toBe(22)
  })

  test('getTools() returns metadata with name, description, and parameters', async () => {
    registry.register(makeTool('test-tool'))

    const tools = registry.getTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('test-tool')
    expect(tools[0].description).toBe('A test tool called test-tool')
    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      required: ['input'],
    })
  })

  test('getTool() returns the tool definition by name', () => {
    const tool = makeTool('my-tool')
    registry.register(tool)

    expect(registry.getTool('my-tool')).toBe(tool)
    expect(registry.getTool('nonexistent')).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Feature test: Registry rejects invalid args
  // -----------------------------------------------------------------------
  test('executeTool rejects invalid arguments', async () => {
    registry.register(makeTool('echo'))

    // input should be string, not number
    const result = await registry.executeTool('echo', { input: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid arguments')
      expect(result.error.message).toContain('echo')
    }
  })

  test('executeTool returns error for unknown tool', async () => {
    const result = await registry.executeTool('nonexistent', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('Unknown tool')
    }
  })

  test('read-only registry omits mutating and privileged tools from metadata', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const parent = await createRegistry()
    const child = createReadOnlyToolRegistry(parent)
    const names = child
      .getTools()
      .map((tool) => tool.name)
      .sort()

    expect(names).toEqual(['file-read', 'web-fetch', 'web-search'])
    expect(names).not.toContain('file-write')
    expect(names).not.toContain('file-edit')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('evolution')
    expect(names).not.toContain('skill-gen')
  })

  test('read-only registry is isolated from the parent registry', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const parent = await createRegistry()
    const child = createReadOnlyToolRegistry(parent)

    expect(parent.getTool('file-write')).toBeDefined()
    expect(parent.getTool('file-edit')).toBeDefined()
    expect(parent.getTool('bash')).toBeDefined()
    expect(parent.size).toBe(25)
    expect(child.getTool('file-write')).toBeUndefined()
    expect(child.size).toBe(3)
  })

  test('toMetadata uses tool.jsonParameters verbatim when present', () => {
    const customSchema = {
      type: 'object',
      properties: { q: { type: 'string', description: 'free text' } },
      required: ['q'],
      additionalProperties: false,
    } as const
    registry.register({
      name: 'mcp__test__search',
      description: 'mcp',
      schema: z.any(),
      jsonParameters: customSchema as unknown as Record<string, unknown>,
      execute: async () => ok({}),
    })
    const meta = registry.getTools().find((t) => t.name === 'mcp__test__search')
    expect(meta).toBeDefined()
    expect(meta?.parameters).toEqual(customSchema)
  })

  test('child registries deny MCP-prefixed tools so subagents never see them', async () => {
    const parent = new ToolRegistry()
    parent.register(makeTool('mcp__example__search'))
    parent.register(makeTool('file-read'))

    const readOnly = createReadOnlyToolRegistry(parent)
    expect(readOnly.getTool('mcp__example__search')).toBeUndefined()
    const readOnlyResult = await readOnly.executeTool('mcp__example__search', { input: 'x' })
    expect(readOnlyResult.ok).toBe(false)
    if (!readOnlyResult.ok) {
      expect(readOnlyResult.error.message).toContain('MCP tools are unavailable')
    }

    parent.register({
      name: 'bash',
      description: 'shell',
      schema: z.object({ command: z.string() }),
      execute: async () => ok({}),
    })
    const test = createTestToolRegistry(parent, { allowedCommands: ['echo'] })
    expect(test.getTool('mcp__example__search')).toBeUndefined()

    const worker = createWorkerToolRegistry(parent, { worktreePath: '/tmp/w' })
    expect(worker.getTool('mcp__example__search')).toBeUndefined()
  })

  test('read-only registry returns clear denied errors for blocked built-in tools', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const parent = await createRegistry()
    const child = createReadOnlyToolRegistry(parent)
    const result = await child.executeTool('file-write', {
      path: '/tmp/should-not-write',
      content: 'nope',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('denied by read-only policy')
      expect(result.error.message).toContain('cannot write files')
    }
  })

  test('executeTool succeeds with valid arguments', async () => {
    registry.register(makeTool('echo'))

    const result = await registry.executeTool('echo', { input: 'hello' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ echo: 'hello' })
    }
  })

  test('executeTool catches thrown errors from tool execute', async () => {
    registry.register({
      name: 'broken',
      description: 'A tool that throws',
      schema: z.object({}),
      execute: async () => {
        throw new Error('kaboom')
      },
    })

    const result = await registry.executeTool('broken', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('threw unexpectedly')
      expect(result.error.message).toContain('kaboom')
    }
  })

  test('skips non-tool files during discovery', async () => {
    // Discover from the tools directory — types.ts and registry.ts should be skipped
    const toolsDir = resolve(import.meta.dir, '../../src/tools')
    await registry.discover(toolsDir)

    // Verify types.ts and registry.ts are NOT registered as tools
    expect(registry.getTool('types')).toBeUndefined()
    expect(registry.getTool('registry')).toBeUndefined()
  })

  test('handles non-existent directory gracefully', async () => {
    await registry.discover('/nonexistent/path/tools')
    expect(registry.size).toBe(0)
  })

  test('unknown Zod type in schema degrades gracefully to empty object', () => {
    registry.register({
      name: 'record-tool',
      description: 'A tool with an unsupported Zod type',
      schema: z.object({ data: z.record(z.string(), z.string()) }),
      execute: async () => ok({ done: true }),
    })

    const tools = registry.getTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: {
        data: {},
      },
      required: ['data'],
    })
  })

  test('createRegistry includes built-in tools without filesystem discovery (bundled regression)', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const bundledRegistry = await createRegistry()
    const names = bundledRegistry
      .getTools()
      .map((tool) => tool.name)
      .sort()

    expect(names).toEqual([
      'apply_worker_diff',
      'ask-user',
      'bash',
      'code-exec',
      'create-artifact',
      'crystallize',
      'dream',
      'enter-mode',
      'evolution',
      'exit-mode',
      'file-edit',
      'file-read',
      'file-write',
      'memory',
      'reflect',
      'self-test',
      'skill-gen',
      'skill-manager',
      'spawn_agent',
      'submit-plan',
      'team_advisor',
      'team_graph',
      'todo',
      'web-fetch',
      'web-search',
    ])
    expect(bundledRegistry.size).toBe(25)
  })

  test('all built-in tools produce JSON Schema with type: "object" (AI SDK requirement)', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const bundledRegistry = await createRegistry()
    const tools = bundledRegistry.getTools()

    for (const tool of tools) {
      expect(tool.parameters).toBeDefined()
      expect((tool.parameters as { type?: string }).type).toBe('object')
    }
  })
})
