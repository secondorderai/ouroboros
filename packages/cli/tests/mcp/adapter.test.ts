import { describe, it, expect } from 'bun:test'
import {
  mcpToolToDefinition,
  mcpToolRegistryName,
  sanitizeToolNameSegment,
  type McpCallToolFn,
} from '@src/mcp/adapter'
import type { McpToolDescriptor } from '@src/mcp/types'

const sampleTool: McpToolDescriptor = {
  name: 'search',
  description: 'Search the index for matching docs.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}

describe('mcp adapter', () => {
  it('produces the canonical mcp__<server>__<tool> registry name', () => {
    expect(mcpToolRegistryName('docs', 'search')).toBe('mcp__docs__search')
  })

  it('sanitizes invalid characters in MCP tool names', () => {
    expect(sanitizeToolNameSegment('do.it!now')).toBe('do_it_now')
    expect(sanitizeToolNameSegment('keep_underscores-and-dashes')).toBe(
      'keep_underscores_and_dashes',
    )
  })

  it('builds a ToolDefinition that carries the server JSON Schema verbatim', () => {
    const callTool: McpCallToolFn = async () => ({ content: [{ type: 'text', text: 'ok' }] })
    const def = mcpToolToDefinition({ serverName: 'docs', tool: sampleTool, callTool })

    expect(def.name).toBe('mcp__docs__search')
    expect(def.description).toBe('Search the index for matching docs.')
    expect(def.jsonParameters).toEqual(sampleTool.inputSchema)
    // schema accepts arbitrary args (validation is delegated to MCP server).
    expect(def.schema.safeParse({ query: 'foo' }).success).toBe(true)
    expect(def.schema.safeParse({ totally: 'invalid' }).success).toBe(true)
  })

  it('execute() unwraps text content into a string ok value', async () => {
    const callTool: McpCallToolFn = async (name, args) => {
      expect(name).toBe('search')
      expect(args).toEqual({ query: 'hello' })
      return {
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }
    }
    const def = mcpToolToDefinition({ serverName: 'docs', tool: sampleTool, callTool })
    const result = await def.execute({ query: 'hello' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('one\ntwo')
  })

  it('execute() prefers structuredContent when present', async () => {
    const callTool: McpCallToolFn = async () => ({
      content: [{ type: 'text', text: 'human-readable' }],
      structuredContent: { rows: 3 },
    })
    const def = mcpToolToDefinition({ serverName: 'docs', tool: sampleTool, callTool })
    const result = await def.execute({ query: 'x' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ rows: 3 })
  })

  it('execute() returns Result.err when the server signals an error', async () => {
    const callTool: McpCallToolFn = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'something blew up' }],
    })
    const def = mcpToolToDefinition({ serverName: 'docs', tool: sampleTool, callTool })
    const result = await def.execute({ query: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('something blew up')
  })

  it('execute() returns Result.err when callTool throws', async () => {
    const callTool: McpCallToolFn = async () => {
      throw new Error('transport closed')
    }
    const def = mcpToolToDefinition({ serverName: 'docs', tool: sampleTool, callTool })
    const result = await def.execute({ query: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('transport closed')
  })
})
