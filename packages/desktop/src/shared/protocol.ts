/**
 * JSON-RPC Protocol Types
 *
 * Shared type definitions for all JSON-RPC messages exchanged between
 * the Electron desktop app and the Ouroboros CLI. Covers the 19 request
 * methods and 10 notification methods defined in the PRD (Section 5.2).
 *
 * These types are imported by both main and renderer processes.
 */

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

// agent/*
export interface AgentRunParams {
  message: string
}

export type AgentCancelParams = Record<string, never>

// session/*
export interface SessionListParams {
  limit?: number
}

export interface SessionLoadParams {
  id: string
}

export type SessionNewParams = Record<string, never>

export interface SessionDeleteParams {
  id: string
}

// config/*
export type ConfigGetParams = Record<string, never>

export interface ConfigSetParams {
  path: string
  value: unknown
}

export type ConfigTestConnectionParams = Record<string, never>

// skills/*
export type SkillsListParams = Record<string, never>

export interface SkillsGetParams {
  name: string
}

// rsi/*
export type RsiDreamParams = Record<string, never>

export type RsiStatusParams = Record<string, never>

// evolution/*
export type EvolutionListParams = Record<string, never>

export type EvolutionStatsParams = Record<string, never>

// approval/*
export type ApprovalListParams = Record<string, never>

export interface ApprovalRespondParams {
  id: string
  approved: boolean
  reason?: string
}

// workspace/*
export interface WorkspaceSetParams {
  directory: string
}

// ── Response Types (19 methods) ────────────────────────────────────

// agent/*
export interface AgentRunResult {
  text: string
  iterations: number
  maxIterationsReached: boolean
}

export interface AgentCancelResult {
  cancelled: boolean
  message?: string
}

// session/*
export interface SessionInfo {
  id: string
  createdAt: string
  lastActive: string
  messageCount: number
  title?: string
}

export interface SessionListResult {
  sessions: SessionInfo[]
}

export interface SessionData {
  id: string
  createdAt: string
  messages: SessionMessage[]
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface SessionNewResult {
  sessionId: string
}

export interface SessionDeleteResult {
  deleted: boolean
}

// config/*
export interface OuroborosConfig {
  model: {
    provider: 'anthropic' | 'openai' | 'openai-compatible'
    name: string
    baseUrl?: string
  }
  permissions: {
    tier0: boolean
    tier1: boolean
    tier2: boolean
    tier3: boolean
    tier4: boolean
  }
  skillDirectories: string[]
  memory: {
    consolidationSchedule: 'session-end' | 'daily' | 'manual'
  }
  rsi: {
    noveltyThreshold: number
    autoReflect: boolean
  }
}

export interface ConfigTestConnectionResult {
  connected: boolean
  error?: string
}

// skills/*
export interface SkillInfo {
  name: string
  description: string
  version: string
  enabled: boolean
}

export interface SkillsListResult {
  skills: SkillInfo[]
}

export interface SkillsGetResult extends SkillInfo {
  instructions: string | null
}

// rsi/*
export interface RsiDreamResult {
  status: string
  message: string
}

export interface RsiStatusResult {
  status: string
  message: string
}

// evolution/*
export interface EvolutionEntry {
  id: string
  timestamp: string
  type: string
  description: string
}

export interface EvolutionListResult {
  entries: EvolutionEntry[]
  message?: string
}

export interface EvolutionStatsResult {
  stats: Record<string, unknown>
  message?: string
}

// approval/*
export interface ApprovalItem {
  id: string
  type: string
  description: string
  createdAt: string
}

export interface ApprovalListResult {
  approvals: ApprovalItem[]
}

export interface ApprovalRespondResult {
  status: string
  message?: string
}

// workspace/*
export interface WorkspaceSetResult {
  directory: string
}

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

export interface AgentTextNotification {
  text: string
}

export interface AgentToolCallStartNotification {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface AgentToolCallEndNotification {
  toolCallId: string
  toolName: string
  result: unknown
  isError: boolean
}

export interface AgentTurnCompleteNotification {
  text: string
  iterations: number
}

export interface AgentErrorNotification {
  message: string
  recoverable: boolean
}

export interface AgentThinkingNotification {
  text: string
}

export interface AgentStatusNotification {
  status: string
  message?: string
}

export interface MemoryUpdatedNotification {
  topic: string
  action: 'created' | 'updated' | 'deleted'
}

export interface SkillActivatedNotification {
  name: string
}

export interface ApprovalRequestNotification {
  id: string
  type: string
  description: string
}

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
  /** Renderer -> Main: send RPC request */
  RPC_REQUEST: 'ouroboros:rpc-request',
  /** Main -> Renderer: CLI notification */
  CLI_NOTIFICATION: 'ouroboros:cli-notification',
  /** Main -> Renderer: CLI status change */
  CLI_STATUS: 'ouroboros:cli-status',
  /** Renderer -> Main: show open dialog */
  SHOW_OPEN_DIALOG: 'ouroboros:show-open-dialog',
  /** Renderer -> Main: get theme */
  GET_THEME: 'ouroboros:get-theme',
  /** Renderer -> Main: set theme */
  SET_THEME: 'ouroboros:set-theme',
  /** Renderer -> Main: get platform */
  GET_PLATFORM: 'ouroboros:get-platform',
} as const
