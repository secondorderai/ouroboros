/**
 * JSON-RPC 2.0 Type Definitions
 *
 * Defines the wire format for requests, responses, notifications, and
 * standard error codes per the JSON-RPC 2.0 specification.
 */

// ── JSON-RPC 2.0 wire types ─────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ── Standard error codes ─────────────────────────────────────────────

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const

// ── Helper constructors ──────────────────────────────────────────────

export function makeResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
}

/**
 * Type guard: checks if a parsed object looks like a valid JSON-RPC 2.0 request.
 */
export function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    o.jsonrpc === '2.0' &&
    (typeof o.id === 'string' || typeof o.id === 'number') &&
    typeof o.method === 'string'
  )
}
