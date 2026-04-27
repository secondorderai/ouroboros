/**
 * MCP (Model Context Protocol) — internal types shared across the
 * adapter, manager, and JSON-RPC handlers.
 */

export type McpServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** Public, serializable view of one MCP server. Used by `mcp/list` RPC. */
export interface McpServerStatusEntry {
  name: string
  type: 'local' | 'remote'
  status: McpServerStatus
  toolCount: number
  errorMessage?: string
  pid?: number
}

/** Notification payloads emitted by the manager. */
export interface McpServerConnectedEvent {
  name: string
  toolCount: number
}

export interface McpServerDisconnectedEvent {
  name: string
  reason?: string
}

export interface McpServerErrorEvent {
  name: string
  message: string
  willRetry: boolean
}

/** Single MCP tool, as returned by `Client.listTools()`. */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    [key: string]: unknown
  }
}
