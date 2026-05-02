import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  ToolRegistry,
  createReadOnlyToolRegistry,
  createTestToolRegistry,
  createWorkerToolRegistry,
} from '@src/tools/registry'
import { setTierApprovalHandler } from '@src/tier-approval'
import { z } from 'zod'
import { ok, err } from '@src/types'
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
    setTierApprovalHandler(null)
  })

  afterEach(() => {
    setTierApprovalHandler(null)
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

  // -----------------------------------------------------------------------
  // Feature test: Tier enforcement
  // -----------------------------------------------------------------------

  const fullPermissions = { tier0: true, tier1: true, tier2: true, tier3: true, tier4: true }
  const tier0OnlyPermissions = {
    tier0: true,
    tier1: false,
    tier2: false,
    tier3: false,
    tier4: false,
  }
  const tier01Permissions = { tier0: true, tier1: true, tier2: false, tier3: false, tier4: false }

  test('executeTool requests one-off approval when a disabled tier is required', async () => {
    registry.register(makeTool('read-tool')) // defaults to tier 1
    registry.register({ ...makeTool('write-tool'), tier: 1 as const })

    registry.setConfigPermissions(tier0OnlyPermissions)
    const approvals: Array<{ name: string; tier: number; args: unknown }> = []
    setTierApprovalHandler(async (name, tier, args) => {
      approvals.push({ name, tier, args })
      return ok(undefined)
    })

    // Both tools are tier 1, which is disabled but can be approved once.
    const readResult = await registry.executeTool('read-tool', { input: 'x' })
    expect(readResult.ok).toBe(true)

    const writeResult = await registry.executeTool('write-tool', { input: 'x' })
    expect(writeResult.ok).toBe(true)
    expect(approvals).toEqual([
      { name: 'read-tool', tier: 1, args: { input: 'x' } },
      { name: 'write-tool', tier: 1, args: { input: 'x' } },
    ])
  })

  test('executeTool uses per-call tier resolver before requesting approval', async () => {
    registry.register({
      name: 'dynamic-tool',
      description: 'A test tool with argument-sensitive permissions',
      schema: z.object({ mode: z.enum(['read', 'write']) }),
      tier: 1,
      resolveTier: (args) => ((args as { mode: string }).mode === 'read' ? 0 : 1),
      execute: async (args) => ok(args),
    })
    registry.setConfigPermissions(tier0OnlyPermissions)

    const approvals: Array<{ name: string; tier: number; args: unknown }> = []
    setTierApprovalHandler(async (name, tier, args) => {
      approvals.push({ name, tier, args })
      return ok(undefined)
    })

    const readResult = await registry.executeTool('dynamic-tool', { mode: 'read' })
    expect(readResult.ok).toBe(true)
    expect(approvals).toEqual([])

    const writeResult = await registry.executeTool('dynamic-tool', { mode: 'write' })
    expect(writeResult.ok).toBe(true)
    expect(approvals).toEqual([{ name: 'dynamic-tool', tier: 1, args: { mode: 'write' } }])
  })

  test('executeTool validates args before tier approval', async () => {
    registry.register({
      ...makeTool('blocked-tool-with-invalid-args'),
      tier: 1,
    })
    registry.setConfigPermissions(tier0OnlyPermissions)

    let handlerCalled = false
    setTierApprovalHandler(async () => {
      handlerCalled = true
      return ok(undefined)
    })

    const result = await registry.executeTool('blocked-tool-with-invalid-args', { input: 123 })
    expect(result.ok).toBe(false)
    expect(handlerCalled).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid arguments')
    }
  })

  test('executeTool allows tools when their tier is enabled', async () => {
    registry.register(makeTool('my-tool'))

    registry.setConfigPermissions(fullPermissions)
    const result = await registry.executeTool('my-tool', { input: 'hello' })
    expect(result.ok).toBe(true)
  })

  test('executeTool is no-op when configPermissions is undefined (backward compat)', async () => {
    registry.register(makeTool('my-tool'))
    // Never call setConfigPermissions — should work as before
    const result = await registry.executeTool('my-tool', { input: 'hello' })
    expect(result.ok).toBe(true)
  })

  test('getToolTier returns the tool tier, defaulting to 1', () => {
    registry.register({ ...makeTool('tier0-tool'), tier: 0 as const })
    registry.register({ ...makeTool('tier2-tool'), tier: 2 as const })
    registry.register(makeTool('no-tier-tool'))

    expect(registry.getToolTier('tier0-tool')).toBe(0)
    expect(registry.getToolTier('tier2-tool')).toBe(2)
    expect(registry.getToolTier('no-tier-tool')).toBe(1)
    expect(registry.getToolTier('nonexistent')).toBeUndefined()
  })

  test('toolsDisabledByTier lists tools that would be blocked', async () => {
    const { createRegistry } = await import('@src/tools/registry')
    const bundledRegistry = await createRegistry()

    const disabled = bundledRegistry.toolsDisabledByTier(tier0OnlyPermissions)
    // file-read, web-fetch, web-search are tier 0 — should NOT be in disabled
    expect(disabled).not.toContain('file-read')
    expect(disabled).not.toContain('web-fetch')
    expect(disabled).not.toContain('web-search')
    // bash, file-write etc. are tier 1 — should be in disabled
    expect(disabled).toContain('bash')
    expect(disabled).toContain('file-write')
    // crystallize is tier 2 — should be in disabled
    expect(disabled).toContain('crystallize')
    // memory is tier 3 — should be in disabled
    expect(disabled).toContain('memory')
  })

  test('toolsDisabledByTier with tier0+tier1 only excludes tier 2+ tools', async () => {
    const { createRegistry } = await import('@src/tools/registry')
    const bundledRegistry = await createRegistry()

    const disabled = bundledRegistry.toolsDisabledByTier(tier01Permissions)
    // tier 0 and 1 tools should NOT be disabled
    expect(disabled).not.toContain('file-read')
    expect(disabled).not.toContain('bash')
    expect(disabled).not.toContain('file-write')
    // tier 2+ tools should be disabled
    expect(disabled).toContain('crystallize')
    expect(disabled).toContain('memory')
    expect(disabled).toContain('evolution')
  })

  test('executeTool enforces tier approval after schema validation', async () => {
    registry.register(makeTool('blocked-tool'))
    registry.setConfigPermissions(tier0OnlyPermissions)

    const result = await registry.executeTool('blocked-tool', { input: 'valid' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('requires tier 1')
    }
  })

  test('all built-in tools have an explicit tier assigned', async () => {
    const { createRegistry } = await import('@src/tools/registry')
    const bundledRegistry = await createRegistry()

    for (const [, tool] of bundledRegistry.entries()) {
      expect(tool.tier).toBeDefined()
      expect(tool.tier).not.toBeUndefined()
      const tierValue = tool.tier!
      expect([0, 1, 2, 3, 4]).toContain(tierValue)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Tier approval handler (Tier 3/4 approval gate)
  // -----------------------------------------------------------------------

  test('setTierApprovalHandler stores the handler', () => {
    const handler = async () => ok(undefined)
    setTierApprovalHandler(handler)
    // No error means it accepted the handler
  })

  test('setTierApprovalHandler accepts null to clear', () => {
    setTierApprovalHandler(async () => ok(undefined))
    setTierApprovalHandler(null)
  })

  test('executeTool invokes tierApprovalHandler for Tier 3 tool when tier is disabled', async () => {
    const tier3Tool: ToolDefinition = {
      name: 'tier3-tool',
      description: 'A tier 3 test tool',
      schema: z.object({}),
      tier: 3,
      execute: async () => ok({ done: true }),
    }
    registry.register(tier3Tool)
    registry.setConfigPermissions({
      tier0: true,
      tier1: true,
      tier2: true,
      tier3: false,
      tier4: true,
    })

    let handlerCalledWith: { name: string; tier: number; args: unknown } | null = null
    setTierApprovalHandler(async (name, tier, args) => {
      handlerCalledWith = { name, tier, args }
      return ok(undefined)
    })

    const result = await registry.executeTool('tier3-tool', { some: 'arg' })
    expect(result.ok).toBe(true)
    expect(handlerCalledWith).not.toBeNull()
    expect(handlerCalledWith!).toEqual({
      name: 'tier3-tool',
      tier: 3,
      args: { some: 'arg' },
    })
  })

  test('executeTool returns error from tierApprovalHandler when denied', async () => {
    const tier4Tool: ToolDefinition = {
      name: 'tier4-tool',
      description: 'A tier 4 test tool',
      schema: z.object({}),
      tier: 4,
      execute: async () => ok({ done: true }),
    }
    registry.register(tier4Tool)
    registry.setConfigPermissions({
      tier0: true,
      tier1: true,
      tier2: true,
      tier3: true,
      tier4: false,
    })

    setTierApprovalHandler(async () => err(new Error('User denied')))

    const result = await registry.executeTool('tier4-tool', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe('User denied')
    }
  })

  test('executeTool does NOT invoke tierApprovalHandler when tier is enabled', async () => {
    const tier3Tool: ToolDefinition = {
      name: 'tier3-enabled-tool',
      description: 'A tier 3 test tool',
      schema: z.object({}),
      tier: 3,
      execute: async () => ok({ done: true }),
    }
    registry.register(tier3Tool)
    registry.setConfigPermissions(fullPermissions)

    let handlerCalled = false
    setTierApprovalHandler(async () => {
      handlerCalled = true
      return ok(undefined)
    })

    await registry.executeTool('tier3-enabled-tool', {})
    expect(handlerCalled).toBe(false)
  })

  test('executeTool invokes tierApprovalHandler for Tier 1/2 tools when disabled', async () => {
    const tier1Tool: ToolDefinition = {
      name: 'tier1-tool',
      description: 'A tier 1 test tool',
      schema: z.object({}),
      tier: 1,
      execute: async () => ok({ done: true }),
    }
    registry.register(tier1Tool)
    registry.setConfigPermissions(tier0OnlyPermissions)

    const calls: Array<{ name: string; tier: number; args: unknown }> = []
    setTierApprovalHandler(async (name, tier, args) => {
      calls.push({ name, tier, args })
      return ok(undefined)
    })

    const result = await registry.executeTool('tier1-tool', {})
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ name: 'tier1-tool', tier: 1, args: {} }])
  })

  test('executeTool returns approval error for Tier 1/2 when no tierApprovalHandler is set', async () => {
    const tier2Tool: ToolDefinition = {
      name: 'tier2-tool',
      description: 'A tier 2 test tool',
      schema: z.object({}),
      tier: 2,
      execute: async () => ok({ done: true }),
    }
    registry.register(tier2Tool)
    registry.setConfigPermissions(tier0OnlyPermissions)
    setTierApprovalHandler(null)

    const result = await registry.executeTool('tier2-tool', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('requires tier 2 approval')
    }
  })
})
