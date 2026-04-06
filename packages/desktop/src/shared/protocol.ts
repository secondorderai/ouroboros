/**
 * JSON-RPC Protocol Types
 *
 * Shared type definitions for all JSON-RPC messages exchanged between
 * the Electron desktop app and the Ouroboros CLI. Covers the 19 request
 * methods and 10 notification methods defined in the PRD (Section 5.2).
 *
 * These types are imported by both main and renderer processes.
 */

// ── Theme Types (from Electron scaffolding) ───────────────────────

/** Theme values supported by the app */
export type Theme = 'light' | 'dark' | 'system'

/** API exposed from main process to renderer via preload script */
export interface ElectronAPI {
  getTheme: () => Promise<Theme>
  setTheme: (theme: Theme) => Promise<void>
  getNativeTheme: () => Promise<'light' | 'dark'>
  onNativeThemeChanged: (callback: (theme: 'light' | 'dark') => void) => () => void
  getPlatform: () => Promise<NodeJS.Platform>
  toggleSidebar: (callback: () => void) => () => void
}

/** IPC bridge API for JSON-RPC communication with CLI */
export interface OuroborosAPI {
  /** Send a JSON-RPC request to the CLI and wait for the response */
  rpc(method: string, params?: unknown): Promise<unknown>
  /** Subscribe to CLI notifications. Returns an unsubscribe function. */
  onNotification(channel: string, callback: (params: unknown) => void): () => void
  /** Show a native open-file dialog. Returns string[] when multiSelections, string otherwise, or null if cancelled. */
  showOpenDialog(options: OpenDialogOptions): Promise<string | string[] | null>
  /** Subscribe to CLI status changes. Returns an unsubscribe function. */
  onCLIStatus(callback: (status: CLIStatus) => void): () => void
}

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<
    'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory'
  >
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    ouroboros: OuroborosAPI
  }
}

// ── Message Types for Conversation Store ──────────────────────────

export type MessageRole = 'user' | 'agent' | 'system' | 'error'

export interface Message {
  id: string
  role: MessageRole
  text: string
  /** ISO-8601 timestamp. */
  timestamp: string
  /** Attached file paths (user messages only). */
  files?: string[]
  /** Completed tool calls that appeared during this agent turn. */
  toolCalls?: CompletedToolCall[]
}

export interface CompletedToolCall {
  id: string
  toolName: string
  input?: unknown
  output?: unknown
  error?: string
  durationMs?: number
}

export interface ToolCallState {
  id: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  output?: unknown
  error?: string
  durationMs?: number
}

// ── Notification Payload Types (CLI -> Renderer) ──────────────────

export interface AgentTextParams {
  /** Incremental text chunk from the agent. */
  text: string
}

export interface AgentToolCallStartParams {
  id: string
  toolName: string
  input?: unknown
}

export interface AgentToolCallEndParams {
  id: string
  toolName?: string
  output?: unknown
  error?: string
  durationMs?: number
}

export interface AgentTurnCompleteParams {
  /** The full text of the agent's response once streaming is done. */
  fullText: string
}

export interface AgentErrorParams {
  message: string
  code?: string
}

// ── JSON-RPC 2.0 Base Types ────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
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

// ── Standard JSON-RPC Error Codes ──────────────────────────────────

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const

// ── Type Guards ────────────────────────────────────────────────────

export function isJsonRpcResponse(obj: unknown): obj is JsonRpcResponse {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    o.jsonrpc === '2.0' &&
    'id' in o &&
    (typeof o.id === 'string' || typeof o.id === 'number' || o.id === null)
  )
}

export function isJsonRpcNotification(obj: unknown): obj is JsonRpcNotification {
  if (obj == null || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return o.jsonrpc === '2.0' && typeof o.method === 'string' && !('id' in o)
}

// ── CLI Status ─────────────────────────────────────────────────────

export type CLIStatus = 'starting' | 'ready' | 'error' | 'restarting'

// ── Request Param Types (19 methods) ───────────────────────────────

export interface AgentRunParams { message: string }
export type AgentCancelParams = Record<string, never>
export interface SessionListParams { limit?: number }
export interface SessionLoadParams { id: string }
export type SessionNewParams = Record<string, never>
export interface SessionDeleteParams { id: string }
export type ConfigGetParams = Record<string, never>
export interface ConfigSetParams { path: string; value: unknown }
export type ConfigTestConnectionParams = Record<string, never>
export type SkillsListParams = Record<string, never>
export interface SkillsGetParams { name: string }
export type RsiDreamParams = Record<string, never>
export type RsiStatusParams = Record<string, never>
export type EvolutionListParams = Record<string, never>
export type EvolutionStatsParams = Record<string, never>
export type ApprovalListParams = Record<string, never>
export interface ApprovalRespondParams { id: string; approved: boolean; reason?: string }
export interface WorkspaceSetParams { directory: string }

// ── Response Types (19 methods) ────────────────────────────────────

export interface AgentRunResult { text: string; iterations: number; maxIterationsReached: boolean }
export interface AgentCancelResult { cancelled: boolean; message?: string }

export interface SessionInfo { id: string; createdAt: string; lastActive: string; messageCount: number; title?: string }
export interface SessionListResult { sessions: SessionInfo[] }
export interface SessionMessage { role: 'user' | 'assistant'; content: string; timestamp: string }
export interface SessionData { id: string; createdAt: string; messages: SessionMessage[] }
export interface SessionNewResult { sessionId: string }
export interface SessionDeleteResult { deleted: boolean }

export interface OuroborosConfig {
  model: { provider: 'anthropic' | 'openai' | 'openai-compatible'; name: string; baseUrl?: string }
  permissions: { tier0: boolean; tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean }
  skillDirectories: string[]
  memory: { consolidationSchedule: 'session-end' | 'daily' | 'manual' }
  rsi: { noveltyThreshold: number; autoReflect: boolean }
}
export interface ConfigTestConnectionResult { connected: boolean; error?: string }

export interface SkillInfo { name: string; description: string; version: string; enabled: boolean }
export interface SkillsListResult { skills: SkillInfo[] }
export interface SkillsGetResult extends SkillInfo { instructions: string | null }

export interface RsiDreamResult { status: string; message: string }
export interface RsiStatusResult { status: string; message: string }

export interface EvolutionEntry { id: string; timestamp: string; type: string; description: string }
export interface EvolutionListResult { entries: EvolutionEntry[]; message?: string }
export interface EvolutionStatsResult { stats: Record<string, unknown>; message?: string }

export interface ApprovalItem { id: string; type: string; description: string; createdAt: string }
export interface ApprovalListResult { approvals: ApprovalItem[] }
export interface ApprovalRespondResult { status: string; message?: string }

export interface WorkspaceSetResult { directory: string }

// ── Method Map (method name -> params & result types) ──────────────

export interface RpcMethodMap {
  'agent/run': { params: AgentRunParams; result: AgentRunResult }
  'agent/cancel': { params: AgentCancelParams; result: AgentCancelResult }
  'session/list': { params: SessionListParams; result: SessionListResult }
  'session/load': { params: SessionLoadParams; result: SessionData }
  'session/new': { params: SessionNewParams; result: SessionNewResult }
  'session/delete': { params: SessionDeleteParams; result: SessionDeleteResult }
  'config/get': { params: ConfigGetParams; result: OuroborosConfig }
  'config/set': { params: ConfigSetParams; result: OuroborosConfig }
  'config/testConnection': { params: ConfigTestConnectionParams; result: ConfigTestConnectionResult }
  'skills/list': { params: SkillsListParams; result: SkillsListResult }
  'skills/get': { params: SkillsGetParams; result: SkillsGetResult }
  'rsi/dream': { params: RsiDreamParams; result: RsiDreamResult }
  'rsi/status': { params: RsiStatusParams; result: RsiStatusResult }
  'evolution/list': { params: EvolutionListParams; result: EvolutionListResult }
  'evolution/stats': { params: EvolutionStatsParams; result: EvolutionStatsResult }
  'approval/list': { params: ApprovalListParams; result: ApprovalListResult }
  'approval/respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'workspace/set': { params: WorkspaceSetParams; result: WorkspaceSetResult }
}

export type RpcMethod = keyof RpcMethodMap

// ── Notification Types (10 notification methods) ───────────────────

export interface AgentTextNotification { text: string }
export interface AgentToolCallStartNotification { toolCallId: string; toolName: string; input: unknown }
export interface AgentToolCallEndNotification { toolCallId: string; toolName: string; result: unknown; isError: boolean }
export interface AgentTurnCompleteNotification { text: string; iterations: number }
export interface AgentErrorNotification { message: string; recoverable: boolean }
export interface AgentThinkingNotification { text: string }
export interface AgentStatusNotification { status: string; message?: string }
export interface MemoryUpdatedNotification { topic: string; action: 'created' | 'updated' | 'deleted' }
export interface SkillActivatedNotification { name: string }
export interface ApprovalRequestNotification { id: string; type: string; description: string }

export interface NotificationMap {
  'agent/text': AgentTextNotification
  'agent/toolCallStart': AgentToolCallStartNotification
  'agent/toolCallEnd': AgentToolCallEndNotification
  'agent/turnComplete': AgentTurnCompleteNotification
  'agent/error': AgentErrorNotification
  'agent/thinking': AgentThinkingNotification
  'agent/status': AgentStatusNotification
  'memory/updated': MemoryUpdatedNotification
  'skill/activated': SkillActivatedNotification
  'approval/request': ApprovalRequestNotification
}

export type NotificationMethod = keyof NotificationMap

// ── IPC Channel Constants ──────────────────────────────────────────

export const IPC_CHANNELS = {
  RPC_REQUEST: 'ouroboros:rpc-request',
  CLI_NOTIFICATION: 'ouroboros:cli-notification',
  CLI_STATUS: 'ouroboros:cli-status',
  SHOW_OPEN_DIALOG: 'ouroboros:show-open-dialog',
} as const
