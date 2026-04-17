/**
 * JSON-RPC Protocol Types
 *
 * Shared type definitions for the JSON-RPC messages exchanged between
 * the Electron desktop app and the Ouroboros CLI.
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
  getPlatform: () => Promise<string>
  toggleSidebar: (callback: () => void) => () => void
  openExternal: (url: string) => void
  getHomeDirectory: () => Promise<string>
  onUpdateDownloaded: (callback: (version: string) => void) => () => void
  installUpdate: () => void
}

/** IPC bridge API for JSON-RPC communication with CLI */
export interface OuroborosAPI {
  /** Send a JSON-RPC request to the CLI and wait for the response */
  rpc<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<RpcMethodMap[M]['result']>
  /** Subscribe to CLI notifications. Returns an unsubscribe function. */
  onNotification<M extends NotificationMethod>(
    channel: M,
    callback: (params: NotificationMap[M]) => void,
  ): () => void
  /** Show a native open-file dialog. Returns string[] when multiSelections, string otherwise, or null if cancelled. */
  showOpenDialog(options: OpenDialogOptions): Promise<string | string[] | null>
  /** Subscribe to CLI status changes. Returns an unsubscribe function. */
  onCLIStatus(callback: (status: CLIStatus) => void): () => void
}

export type RpcArgs<M extends RpcMethod> = [params?: RpcMethodMap[M]['params']]

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
  toolCallId: string
  toolName: string
  input?: unknown
}

export interface AgentToolCallEndParams {
  toolCallId: string
  toolName: string
  result?: unknown
  isError?: boolean
}

export interface AgentTurnCompleteParams {
  /** The full text of the agent's response once streaming is done. */
  text: string
  iterations?: number
}

export interface AgentErrorParams {
  message: string
  recoverable?: boolean
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

/** AI provider type used in onboarding and settings */
export type AIProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt'
export type AuthMethod = 'browser' | 'headless'

// ── Request Param Types ────────────────────────────────────────────

export type AgentClient = 'desktop' | 'cli'
export type AgentResponseStyle = 'default' | 'desktop-readable'

export interface AgentRunParams {
  message: string
  files?: string[]
  client?: AgentClient
  responseStyle?: AgentResponseStyle
}
export type AgentCancelParams = Record<string, never>
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
export type ConfigGetParams = Record<string, never>
export interface ConfigSetParams {
  path: string
  value: unknown
}
export interface ConfigSetApiKeyParams {
  provider: AIProvider
  apiKey: string
}
export interface ConfigTestConnectionParams {
  provider: AIProvider
  apiKey?: string
  baseUrl?: string
}
export interface AuthGetStatusParams {
  provider: AIProvider
}
export interface AuthStartLoginParams {
  provider: AIProvider
  method?: AuthMethod
}
export interface AuthPollLoginParams {
  provider: AIProvider
  flowId: string
}
export interface AuthCancelLoginParams {
  provider: AIProvider
  flowId: string
}
export interface AuthLogoutParams {
  provider: AIProvider
}
export type SkillsListParams = Record<string, never>
export interface SkillsGetParams {
  name: string
}
export type RsiDreamParams = Record<string, never>
export type RsiStatusParams = Record<string, never>
export interface EvolutionListParams {
  limit?: number
}
export type EvolutionStatsParams = Record<string, never>
export type ApprovalListParams = Record<string, never>
export interface ApprovalRespondParams {
  id: string
  approved: boolean
  reason?: string
}
export interface WorkspaceSetParams {
  directory: string
}

// ── Response Types (19 methods) ────────────────────────────────────

export interface AgentRunResult {
  text: string
  iterations: number
  maxIterationsReached: boolean
}
export interface AgentCancelResult {
  cancelled: boolean
  message?: string
}

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
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}
export interface SessionData {
  id: string
  createdAt: string
  messages: SessionMessage[]
}
export interface SessionNewResult {
  sessionId: string
}
export interface SessionDeleteResult {
  deleted: boolean
}

export interface OuroborosConfig {
  model: {
    provider: 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt'
    name: string
    baseUrl?: string
  }
  permissions: { tier0: boolean; tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean }
  skillDirectories: string[]
  memory: { consolidationSchedule: 'session-end' | 'daily' | 'manual' }
  rsi: { noveltyThreshold: number; autoReflect: boolean }
}
export interface ConfigSetApiKeyResult {
  ok: boolean
}

/** Result from a connection test — used in onboarding wizard */
export interface ConnectionTestResult {
  success: boolean
  error?: string
  models?: string[]
}
export type ConfigTestConnectionResult = ConnectionTestResult
export interface AuthStatusResult {
  provider: AIProvider
  connected: boolean
  authType: 'oauth' | null
  pending: boolean
  accountId?: string
  availableMethods: AuthMethod[]
  models: string[]
}
export interface AuthStartLoginResult {
  flowId: string
  provider: AIProvider
  method: AuthMethod
  url: string
  instructions: string
  pending: true
}
export interface AuthPollLoginResult extends AuthStatusResult {
  flowId: string
  method: AuthMethod
  success: boolean
  error?: string
}
export interface AuthCancelLoginResult {
  cancelled: boolean
}
export interface AuthLogoutResult {
  ok: boolean
}

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

export interface RsiDreamResult {
  status: string
  message: string
}
export interface RsiStatusResult {
  status: string
  message: string
}

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

export interface ApprovalItem {
  id: string
  type: string
  description: string
  createdAt: string
  risk?: 'high' | 'medium' | 'low'
  diff?: string
}
export interface ApprovalListResult {
  approvals: ApprovalItem[]
}
export interface ApprovalRespondResult {
  status: string
  message?: string
}

export interface WorkspaceSetResult {
  directory: string
}

// ── Mode Types ──────────────────────────────────────────────────────

export interface PlanStep {
  description: string
  targetFiles: string[]
  tools: string[]
  dependsOn?: number[]
}

export interface Plan {
  title: string
  summary: string
  steps: PlanStep[]
  exploredFiles: string[]
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  feedback?: string
}

export type ModeState =
  | { status: 'inactive' }
  | { status: 'active'; modeId: string; enteredAt: string }

export interface ModeGetStateParams {
  [key: string]: never
}
export interface ModeEnterParams {
  mode: string
  reason?: string
}
export interface ModeEnterResult {
  displayName: string
}
export interface ModeExitParams {
  reason?: string
}
export interface ModeExitResult {
  displayName: string
}
export interface ModeGetPlanParams {
  [key: string]: never
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
  'config/setApiKey': { params: ConfigSetApiKeyParams; result: ConfigSetApiKeyResult }
  'config/testConnection': {
    params: ConfigTestConnectionParams
    result: ConfigTestConnectionResult
  }
  'auth/getStatus': { params: AuthGetStatusParams; result: AuthStatusResult }
  'auth/startLogin': { params: AuthStartLoginParams; result: AuthStartLoginResult }
  'auth/pollLogin': { params: AuthPollLoginParams; result: AuthPollLoginResult }
  'auth/cancelLogin': { params: AuthCancelLoginParams; result: AuthCancelLoginResult }
  'auth/logout': { params: AuthLogoutParams; result: AuthLogoutResult }
  'skills/list': { params: SkillsListParams; result: SkillsListResult }
  'skills/get': { params: SkillsGetParams; result: SkillsGetResult }
  'rsi/dream': { params: RsiDreamParams; result: RsiDreamResult }
  'rsi/status': { params: RsiStatusParams; result: RsiStatusResult }
  'evolution/list': { params: EvolutionListParams; result: EvolutionListResult }
  'evolution/stats': { params: EvolutionStatsParams; result: EvolutionStatsResult }
  'approval/list': { params: ApprovalListParams; result: ApprovalListResult }
  'approval/respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'workspace/set': { params: WorkspaceSetParams; result: WorkspaceSetResult }
  'mode/getState': { params: ModeGetStateParams; result: ModeState }
  'mode/enter': { params: ModeEnterParams; result: ModeEnterResult }
  'mode/exit': { params: ModeExitParams; result: ModeExitResult }
  'mode/getPlan': { params: ModeGetPlanParams; result: Plan | null }
}

export type RpcMethod = keyof RpcMethodMap

// ── Notification Types ─────────────────────────────────────────────

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
  recoverable?: boolean
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
  createdAt?: string
  risk?: 'high' | 'medium' | 'low'
  diff?: string
}
export interface RsiReflectionNotification {
  description?: string
}
export interface RsiCrystallizationNotification {
  outcome?: string
  skillName?: string
  description?: string
}
export interface RsiDreamNotification {
  message?: string
}
export interface RsiErrorNotification {
  message?: string
}
export interface RsiRuntimeNotification {
  eventType: string
  payload: Record<string, unknown>
}

export interface ModeEnteredNotification {
  modeId: string
  displayName: string
  reason: string
}
export interface ModeExitedNotification {
  modeId: string
  reason: string
}
export interface ModePlanSubmittedNotification {
  plan: Plan
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
  'rsi/reflection': RsiReflectionNotification
  'rsi/crystallization': RsiCrystallizationNotification
  'rsi/dream': RsiDreamNotification
  'rsi/error': RsiErrorNotification
  'rsi/runtime': RsiRuntimeNotification
  'mode/entered': ModeEnteredNotification
  'mode/exited': ModeExitedNotification
  'mode/planSubmitted': ModePlanSubmittedNotification
}

export type NotificationMethod = keyof NotificationMap

// ── IPC Channel Constants ──────────────────────────────────────────

export const IPC_CHANNELS = {
  RPC_REQUEST: 'ouroboros:rpc-request',
  CLI_NOTIFICATION: 'ouroboros:cli-notification',
  CLI_STATUS: 'ouroboros:cli-status',
  SHOW_OPEN_DIALOG: 'ouroboros:show-open-dialog',
} as const
