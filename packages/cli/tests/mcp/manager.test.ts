import { afterEach, beforeEach, describe, it, expect } from 'bun:test'
import { resolve } from 'node:path'
import { ToolRegistry } from '@src/tools/registry'
import { McpManager } from '@src/mcp/manager'
import type { McpServerConfig } from '@src/config'

const FIXTURE = resolve(import.meta.dir, '..', 'fixtures', 'mcp-echo-server.ts')

function localServer(
  name: string,
  overrides: Partial<{ env: Record<string, string> }> = {},
): McpServerConfig {
  return {
    type: 'local',
    name,
    command: 'bun',
    args: ['run', FIXTURE],
    env: overrides.env ?? {},
    timeout: 10_000,
    requireApproval: false,
  }
}

describe('McpManager', () => {
  let registry: ToolRegistry
  let manager: McpManager | null = null
  const connected: string[] = []
  const disconnected: string[] = []
  const errors: Array<{ name: string; message: string }> = []

  beforeEach(() => {
    registry = new ToolRegistry()
    connected.length = 0
    disconnected.length = 0
    errors.length = 0
  })

  afterEach(async () => {
    if (manager) {
      await manager.stop()
      manager = null
    }
  })

  it('starts a stdio MCP server and registers its tools with the prefixed name', async () => {
    manager = new McpManager({
      config: { servers: [localServer('echo')] },
      registry,
      handlers: {
        onServerConnected: (e) => connected.push(e.name),
        onServerDisconnected: (e) => disconnected.push(e.name),
        onServerError: (e) => errors.push({ name: e.name, message: e.message }),
      },
    })
    await manager.start()

    expect(connected).toContain('echo')
    expect(errors).toEqual([])
    expect(registry.getTool('mcp__echo__echo')).toBeDefined()
    expect(registry.getTool('mcp__echo__add')).toBeDefined()
    const meta = registry.getTools().find((t) => t.name === 'mcp__echo__echo')
    expect(meta?.parameters).toMatchObject({ type: 'object' })
  })

  it('round-trips a tool call through the registry and returns text content', async () => {
    manager = new McpManager({
      config: { servers: [localServer('echo')] },
      registry,
    })
    await manager.start()

    const result = await registry.executeTool('mcp__echo__echo', { text: 'hi there' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('hi there')
  })

  it('exposes structuredContent when the MCP server provides it', async () => {
    manager = new McpManager({
      config: { servers: [localServer('echo')] },
      registry,
    })
    await manager.start()

    const result = await registry.executeTool('mcp__echo__add', { a: 2, b: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ sum: 5, formula: '2 + 3' })
  })

  it('reports server status and pid via getServerStatuses()', async () => {
    manager = new McpManager({
      config: { servers: [localServer('echo')] },
      registry,
    })
    await manager.start()

    const statuses = manager.getServerStatuses()
    expect(statuses).toHaveLength(1)
    expect(statuses[0].name).toBe('echo')
    expect(statuses[0].status).toBe('connected')
    expect(statuses[0].toolCount).toBeGreaterThan(0)
    expect(typeof statuses[0].pid === 'number' || statuses[0].pid === undefined).toBe(true)
  })

  it('rejects duplicate server names at construction time', () => {
    expect(
      () =>
        new McpManager({
          config: { servers: [localServer('dup'), localServer('dup')] },
          registry,
        }),
    ).toThrow(/Duplicate MCP server name/)
  })

  it('marks remote servers as errored in Phase 1 (HTTP transport not supported)', async () => {
    manager = new McpManager({
      config: {
        servers: [
          {
            type: 'remote',
            name: 'remote',
            url: 'https://example.com',
            headers: {},
            timeout: 1000,
            requireApproval: 'first-call',
          },
        ],
      },
      registry,
      handlers: {
        onServerConnected: (e) => connected.push(e.name),
        onServerDisconnected: (e) => disconnected.push(e.name),
        onServerError: (e) => errors.push({ name: e.name, message: e.message }),
      },
    })
    await manager.start()

    expect(connected).toEqual([])
    expect(errors.some((e) => /not supported/i.test(e.message))).toBe(true)
    const status = manager.getServerStatuses()[0]
    expect(status.status).toBe('error')
  })

  it('restartServer() bounces and re-registers tools', async () => {
    manager = new McpManager({
      config: { servers: [localServer('echo')] },
      registry,
    })
    await manager.start()

    const result = await manager.restartServer('echo')
    expect(result.ok).toBe(true)
    expect(registry.getTool('mcp__echo__echo')).toBeDefined()

    const call = await registry.executeTool('mcp__echo__echo', { text: 'after restart' })
    expect(call.ok).toBe(true)
    if (call.ok) expect(call.value).toBe('after restart')
  })

  it('returns an error from restartServer() for unknown server names', async () => {
    manager = new McpManager({ config: { servers: [] }, registry })
    await manager.start()
    const result = await manager.restartServer('nope')
    expect(result.ok).toBe(false)
  })
})
