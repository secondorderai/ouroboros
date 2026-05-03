#!/usr/bin/env bun
/**
 * Minimal MCP server used by the integration tests.
 *
 * Exposes three tools:
 *   - echo({ text }) -> text
 *   - add({ a, b })  -> { sum, formula }
 *   - getEnv({ key }) -> { value }   (used to verify env-scrubbing)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

async function main(): Promise<void> {
  const server = new McpServer({ name: 'echo-server', version: '0.0.1' })

  server.registerTool(
    'echo',
    {
      description: 'Echo the supplied text back to the caller.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: 'text', text }],
    }),
  )

  server.registerTool(
    'add',
    {
      description: 'Return the sum of two numbers.',
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => {
      const sum = a + b
      return {
        content: [{ type: 'text', text: `${a} + ${b} = ${sum}` }],
        structuredContent: { sum, formula: `${a} + ${b}` },
      }
    },
  )

  server.registerTool(
    'getEnv',
    {
      description: 'Return the value of an environment variable in the spawned MCP process.',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      const value = process.env[key] ?? null
      return {
        content: [{ type: 'text', text: value === null ? '<unset>' : value }],
        structuredContent: { value },
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

void main()
