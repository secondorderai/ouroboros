/**
 * Adapter: bridge an MCP tool descriptor into a Ouroboros `ToolDefinition`.
 *
 * Each MCP tool becomes a registry entry named `mcp__<server>__<tool>`.
 * Local Zod validation is delegated (the MCP server is the schema authority);
 * `jsonParameters` carries the server-supplied JSON Schema verbatim so the
 * LLM sees the real shape.
 */

import { z } from 'zod'
import { ok, err } from '@src/types'
import { MCP_TOOL_PREFIX } from '@src/tools/registry'
import type { ToolDefinition } from '@src/tools/types'
import type { McpToolDescriptor } from './types'

/** Sanitize an MCP-supplied tool name into the `[a-zA-Z0-9_]` charset. */
export function sanitizeToolNameSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** Build the prefixed registry name for an MCP tool. */
export function mcpToolRegistryName(serverName: string, mcpToolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${sanitizeToolNameSegment(mcpToolName)}`
}

/** Result-shaped output from a single MCP `callTool` invocation. */
export interface McpCallToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
  [key: string]: unknown
}

/** Function the adapter calls into to actually invoke the MCP server. */
export type McpCallToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpCallToolResult>

export interface McpAdapterOptions {
  serverName: string
  tool: McpToolDescriptor
  callTool: McpCallToolFn
}

/**
 * Convert an MCP tool descriptor into a `ToolDefinition` for the registry.
 *
 * - `schema` is `z.any()` so the registry's `safeParse()` always passes; the
 *   MCP server validates the real shape and returns structured errors.
 * - `jsonParameters` carries the server-supplied JSON Schema unchanged — the
 *   registry's `getTools()` returns it verbatim to the LLM.
 * - `execute` invokes the supplied `callTool` callback and translates the
 *   MCP result envelope into a Ouroboros `Result<unknown>`.
 */
export function mcpToolToDefinition(options: McpAdapterOptions): ToolDefinition {
  const { serverName, tool, callTool } = options
  const registryName = mcpToolRegistryName(serverName, tool.name)
  const description = tool.description ?? `MCP tool ${tool.name} from server "${serverName}"`

  return {
    name: registryName,
    description,
    schema: z.any(),
    jsonParameters: tool.inputSchema as Record<string, unknown>,
    execute: async (args, context) => {
      const callArgs =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {}
      try {
        const response = await callTool(tool.name, callArgs, context?.abortSignal)
        if (response.isError === true) {
          return err(new Error(formatMcpErrorContent(response, registryName)))
        }
        return ok(extractMcpToolValue(response))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return err(new Error(`MCP tool "${registryName}" failed: ${message}`))
      }
    },
  }
}

function formatMcpErrorContent(response: McpCallToolResult, registryName: string): string {
  const text = textFromContent(response.content)
  if (text) return `MCP tool "${registryName}" returned error: ${text}`
  return `MCP tool "${registryName}" returned error result`
}

function extractMcpToolValue(response: McpCallToolResult): unknown {
  if (response.structuredContent !== undefined) return response.structuredContent
  const text = textFromContent(response.content)
  if (text !== null) return text
  return response.content ?? null
}

function textFromContent(content: McpCallToolResult['content'] | undefined): string | null {
  if (!Array.isArray(content) || content.length === 0) return null
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}
