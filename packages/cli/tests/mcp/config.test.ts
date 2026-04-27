import { describe, it, expect } from 'bun:test'
import { mcpConfigSchema, mcpServerSchema } from '@src/config'

describe('mcp config schema', () => {
  it('accepts a minimal local server entry and applies defaults', () => {
    const parsed = mcpServerSchema.parse({
      type: 'local',
      name: 'echo',
      command: 'bun',
      args: ['run', 'fixture.ts'],
    })
    expect(parsed.type).toBe('local')
    if (parsed.type === 'local') {
      expect(parsed.timeout).toBe(30000)
      expect(parsed.requireApproval).toBe('first-call')
      expect(parsed.env).toEqual({})
    }
  })

  it('rejects server names with invalid characters', () => {
    const result = mcpServerSchema.safeParse({
      type: 'local',
      name: 'BAD NAME',
      command: 'bun',
    })
    expect(result.success).toBe(false)
  })

  it('rejects local servers missing a command', () => {
    const result = mcpServerSchema.safeParse({
      type: 'local',
      name: 'good',
      command: '',
    })
    expect(result.success).toBe(false)
  })

  it('parses a remote server entry', () => {
    const parsed = mcpServerSchema.parse({
      type: 'remote',
      name: 'remote-srv',
      url: 'https://mcp.example.com',
    })
    expect(parsed.type).toBe('remote')
    if (parsed.type === 'remote') {
      expect(parsed.headers).toEqual({})
      expect(parsed.timeout).toBe(30000)
    }
  })

  it('accepts requireApproval=false to disable approval prompts', () => {
    const parsed = mcpServerSchema.parse({
      type: 'local',
      name: 'trusted',
      command: 'bun',
      requireApproval: false,
    })
    expect(parsed.requireApproval).toBe(false)
  })

  it('mcpConfigSchema defaults to an empty servers array', () => {
    const parsed = mcpConfigSchema.parse({})
    expect(parsed).toEqual({ servers: [] })
  })
})
