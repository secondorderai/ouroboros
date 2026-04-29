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
  /**
   * Open a local artifact file in the OS default application. Path must be an
   * absolute filesystem path returned by the CLI (e.g. via `artifacts/list`);
   * the main process validates it lives under a `memory/sessions/*\/artifacts/`
   * directory and ends in `.html` before invoking `shell.openPath`.
   */
  openArtifact: (path: string) => void
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
  /** Validate local image paths and return safe metadata plus renderer preview data. */
  validateImageAttachments(paths: string[]): Promise<ImageAttachmentValidationResult>
  /** Subscribe to CLI status changes. Returns an unsubscribe function. */
  onCLIStatus(callback: (status: CLIStatus) => void): () => void
  /**
   * Show a native save-file dialog and write the artifact's HTML to the
   * chosen path. Returns `{ saved: false }` if the user cancels.
   */
  saveArtifact(args: SaveArtifactArgs): Promise<SaveArtifactResult>
}

export interface SaveArtifactArgs {
  /** Full HTML content to write to disk. */
  html: string
  /**
   * Suggested filename (without extension). Will be sanitized in main and
   * paired with `.html` as the dialog's default name.
   */
  defaultName: string
}

export interface SaveArtifactResult {
  saved: boolean
  /** Absolute path the file was written to. Present iff `saved === true`. */
  path?: string
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

export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface ImageAttachment {
  path: string
  name: string
  mediaType: SupportedImageMediaType
  sizeBytes: number
  previewDataUrl?: string
}

export interface RejectedImageAttachment {
  path: string
  reason: string
}

export interface ImageAttachmentValidationResult {
  accepted: ImageAttachment[]
  rejected: RejectedImageAttachment[]
}

export interface Message {
  id: string
  role: MessageRole
  text: string
  /** ISO-8601 timestamp. */
  timestamp: string
  /** Attached file paths (user messages only). */
  files?: string[]
  /** Attached image metadata and optional local preview data (user messages only). */
  imageAttachments?: ImageAttachment[]
  /** Completed tool calls that appeared during this agent turn. */
  toolCalls?: CompletedToolCall[]
  /** Subagent activity that appeared during this agent turn. */
  subagentRuns?: SubagentRun[]
  /** Skills active for this agent turn (deduped by name). Set on assistant
   * messages only — sourced from the user's slash-picker selection plus any
   * skills the LLM activates mid-turn via skill-manager. */
  activatedSkills?: string[]
  /**
   * Variant marker for special user messages. `'steer'` flags a mid-turn
   * steering message so the chat view can render it with a distinct accent
   * and lifecycle state (pending → injected → orphaned).
   */
  kind?: 'steer'
  /**
   * Lifecycle of a steered user message:
   * - `pending`  : sent over RPC, awaiting injection at the next iteration top.
   * - `injected` : the agent loop drained the queue and the model has seen it.
   * - `orphaned` : the run ended (cancelled or completed) before injection.
   * Only meaningful when `kind === 'steer'`.
   */
  steerStatus?: 'pending' | 'injected' | 'orphaned'
  /**
   * Caller-supplied id used for idempotency on `agent/steer`. Persisted only
   * in the live store so notifications can be correlated back to the bubble.
   */
  steerRequestId?: string
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

export type SubagentRunUiStatus = 'running' | 'completed' | 'failed'

export interface SubagentEvidenceReference {
  type: 'file' | 'command' | 'output'
  label: string
  path?: string
  line?: number
  endLine?: number
}

export type PermissionLeaseStatus = 'pending' | 'active' | 'denied'

export interface PermissionLeaseDisplayDetails {
  leaseId: string
  agentRunId: string
  requestedTools: string[]
  requestedPaths: string[]
  requestedBashCommands: string[]
  expiresAt?: string
  riskSummary: string
  risk: 'high' | 'medium' | 'low'
  createdAt: string
  status: PermissionLeaseStatus
  approvedAt?: string
  denialReason?: string
}

export type WorkerDiffReviewStatus =
  | 'awaiting-review'
  | 'reviewed'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'blocked'

export interface WorkerDiffTestResult {
  command: string
  exitCode: number
  durationMs?: number
  outputExcerpt?: string
  status: 'passed' | 'failed'
}

export interface WorkerDiffDisplayDetails {
  taskId: string
  branchName?: string
  worktreePath: string
  changedFiles: string[]
  diff: string
  diffLineCount?: number
  testResult?: WorkerDiffTestResult
  unresolvedRisks: string[]
  reviewStatus: WorkerDiffReviewStatus
  approvalId?: string
  action?: 'apply-patch'
  description?: string
  createdAt?: string
  risk?: 'high' | 'medium' | 'low'
  approvedAt?: string
  denialReason?: string
}

export interface SubagentRun {
  runId: string
  parentSessionId?: string
  childSessionId?: string
  agentId: string
  task: string
  status: SubagentRunUiStatus
  startedAt: string
  updatedAt?: string
  completedAt?: string
  message?: string
  summary?: string
  evidenceCount: number
  uncertaintyCount: number
  evidence: SubagentEvidenceReference[]
  permissionLeases?: PermissionLeaseDisplayDetails[]
  workerDiff?: WorkerDiffDisplayDetails
  failureMessage?: string
}

// ── Notification Payload Types (CLI -> Renderer) ──────────────────
//
// Every agent/* notification carries `sessionId` so the renderer can route
// concurrent runs without crosstalk. `null` means the event fired outside
// any session (legacy single-session events, or rare process-wide events).

export interface AgentTextParams {
  sessionId: string | null
  /** Incremental text chunk from the agent. */
  text: string
}

export interface AgentContextUsageParams {
  sessionId: string | null
  estimatedTotalTokens: number
  contextWindowTokens: number | null
  usageRatio: number | null
  threshold: 'within-budget' | 'warn' | 'flush' | 'compact'
  breakdown?: {
    systemPromptTokens: number
    toolPromptTokens: number
    agentsInstructionsTokens: number
    memoryTokens: number
    conversationTokens: number
    toolResultTokens: number
  }
  contextWindowSource?: 'config' | 'model-registry' | 'fallback' | 'unknown'
}

export interface AgentToolCallStartParams {
  sessionId: string | null
  toolCallId: string
  toolName: string
  input?: unknown
}

export interface AgentToolCallEndParams {
  sessionId: string | null
  toolCallId: string
  toolName: string
  result?: unknown
  isError?: boolean
}

export interface AgentTurnCompleteParams {
  sessionId: string | null
  /** The full text of the agent's response once streaming is done. */
  text: string
  iterations?: number
}

export interface AgentErrorParams {
  sessionId: string | null
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
export type AgentStopReason = 'completed' | 'max_steps' | 'error'
export type WorkspaceMode = 'simple' | 'workspace'

export interface AgentRunParams {
  message: string
  files?: string[]
  images?: ImageAttachment[]
  skillName?: string
  client?: AgentClient
  responseStyle?: AgentResponseStyle
  maxSteps?: number
  /**
   * Session this run belongs to. Pinned at the start of the run so persistence
   * always lands on the right session even if the user switches views before
   * the turn completes. Falls back to the CLI's currently-viewed session when
   * omitted (legacy single-session callers).
   */
  sessionId?: string
}
/**
 * Cancel a specific session's in-flight run. Falls back to the currently
 * viewed session when omitted.
 */
export interface AgentCancelParams {
  sessionId?: string
}

/**
 * Inject a user message into the in-flight run for a session. The message is
 * queued and drained at the next ReAct iteration top. `requestId` is a UUID
 * generated by the renderer and used by the CLI for idempotent retries.
 */
export interface AgentSteerParams {
  message: string
  requestId: string
  sessionId?: string
  images?: ImageAttachment[]
}

export interface AgentSteerResult {
  accepted: boolean
  /** True when the requestId has already been seen for this run. */
  duplicate?: boolean
  /** Reason for rejection, e.g. `'no-active-run'`. */
  reason?: string
}
export interface SessionListParams {
  limit?: number
  offset?: number
}
export interface SessionLoadParams {
  id: string
}
export interface SessionNewParams {
  workspaceMode?: WorkspaceMode
  workspacePath?: string
}
export interface SessionDeleteParams {
  id: string
}
export interface SessionRenameParams {
  id: string
  title: string
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
export interface SkillsListParams {
  includeDisabled?: boolean
}
export interface SkillsGetParams {
  name: string
}
export type RsiDreamParams = Record<string, never>
export type RsiStatusParams = Record<string, never>
export interface RsiHistoryParams {
  limit?: number
}
export interface RsiCheckpointParams {
  sessionId: string
}
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
export interface AskUserRespondParams {
  id: string
  response: string
}
export interface WorkspaceSetParams {
  directory: string
}
export type WorkspaceClearParams = Record<string, never>

export type TaskGraphStatus = 'draft' | 'running' | 'paused' | 'failed' | 'cancelled' | 'completed'
export type TaskNodeStatus =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type TeamAgentStatus = 'active' | 'cancelled' | 'completed'

export interface QualityGate {
  id: string
  description: string
  required: boolean
  status: 'pending' | 'passed' | 'failed'
}

export interface TaskNode {
  id: string
  title: string
  description?: string
  status: TaskNodeStatus
  dependencies: string[]
  assignedAgentId?: string
  requiredArtifacts: string[]
  qualityGates: QualityGate[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancellationReason?: string
}

export interface TeamAgent {
  id: string
  status: TeamAgentStatus
  activeTaskIds: string[]
  updatedAt: string
}

export interface TeamMessage {
  id: string
  message: string
  agentId?: string
  taskId?: string
  createdAt: string
}

export interface TaskGraph {
  id: string
  name: string
  status: TaskGraphStatus
  tasks: TaskNode[]
  agents: TeamAgent[]
  messages: TeamMessage[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  cancelledAt?: string
  cancellationReason?: string
}

export interface TeamTaskInput {
  id?: string
  title: string
  description?: string
  dependencies?: string[]
  assignedAgentId?: string
  requiredArtifacts?: string[]
  qualityGates?: Array<{
    id?: string
    description: string
    required?: boolean
    status?: 'pending' | 'passed' | 'failed'
  }>
}

export interface TeamCreateParams {
  name?: string
  tasks?: TeamTaskInput[]
}
export type WorkflowTemplateName =
  | 'parallel-investigation'
  | 'pre-merge-red-team'
  | 'architecture-decision'
  | 'review-triad'
export interface TeamCreateWorkflowParams {
  template: WorkflowTemplateName
  taskContext: string
  name?: string
}
export interface TeamGraphParams {
  graphId: string
}
export interface TeamCancelParams extends TeamGraphParams {
  reason?: string
}
export interface TeamAddTaskParams extends TeamGraphParams {
  task: TeamTaskInput
}
export interface TeamAssignTaskParams extends TeamGraphParams {
  taskId: string
  agentId: string
}
export interface TeamSendMessageParams extends TeamGraphParams {
  message: string
  agentId?: string
  taskId?: string
}
export interface TeamGraphResult {
  graph: TaskGraph
}
export interface TeamGraphNotification {
  graph: TaskGraph
  reason?: string
}
export interface TeamAddTaskResult {
  graph: TaskGraph
  task: TaskNode
}
export interface TeamAssignTaskResult {
  graph: TaskGraph
  task: TaskNode
}
export interface TeamCleanupResult {
  cleaned: true
  graphId: string
}
export interface TeamSendMessageResult {
  graph: TaskGraph
  message: TeamMessage
}

// ── Response Types ─────────────────────────────────────────────────

export interface AgentRunResult {
  text: string
  iterations: number
  stopReason: AgentStopReason
  maxIterationsReached: boolean
}
export interface AgentCancelResult {
  cancelled: boolean
  message?: string
}

export interface AgentSteerInjectedParams {
  sessionId: string | null
  /** The requestId the renderer assigned when calling `agent/steer`. */
  steerId: string
  /** Iteration number at which the steer was injected (1-based). */
  iteration: number
  text: string
}

export interface AgentSteerOrphanedParams {
  sessionId: string | null
  /**
   * `'cancelled'` — the user cancelled the run while items were queued.
   * `'turn-completed'` — the run ended cleanly before injection (steer
   * arrived during final-answer streaming, error path, or max-steps).
   */
  reason: 'cancelled' | 'turn-completed'
  steers: Array<{ id: string; text: string }>
}

export interface AgentTurnAbortedParams {
  sessionId: string | null
  iterations: number
  partialText: string
}

export interface SessionInfo {
  id: string
  createdAt: string
  lastActive: string
  messageCount: number
  title?: string
  titleSource?: 'auto' | 'manual'
  workspacePath?: string | null
  workspaceMode?: WorkspaceMode
  runStatus?: 'idle' | 'running' | 'error'
  activeToolName?: string
}
export interface SessionListResult {
  sessions: SessionInfo[]
  hasMore: boolean
}
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  imageAttachments?: ImageAttachment[]
  /** Tool calls made during this assistant turn (assistant role only). */
  toolCalls?: CompletedToolCall[]
  /** Skills active for this assistant turn (deduped by name). */
  activatedSkills?: string[]
}
export interface SessionData {
  id: string
  createdAt: string
  workspacePath?: string | null
  workspaceMode?: WorkspaceMode
  messages: SessionMessage[]
}
export interface SessionNewResult {
  sessionId: string
  workspacePath?: string | null
  workspaceMode?: WorkspaceMode
}
export interface SessionDeleteResult {
  deleted: boolean
}
export interface SessionRenameResult {
  id: string
  title: string
  titleSource: 'manual'
}

export interface OuroborosConfig {
  model: {
    provider: 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt'
    name: string
    baseUrl?: string
    apiKey?: string
    /**
     * Reasoning effort. Maps to Anthropic adaptive thinking on Claude 4.6+ or
     * to OpenAI reasoning_effort on o-series and GPT-5. Silently ignored on
     * unsupported models. `minimal` is OpenAI-only; `max` is Anthropic-only —
     * out-of-range values are clamped to the closest supported level.
     */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'max'
  }
  permissions: { tier0: boolean; tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean }
  skillDirectories: string[]
  disabledSkills: string[]
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
  status?: 'core' | 'staging' | 'generated' | 'builtin'
  path?: string
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

export interface RSIDurableMemoryCandidate {
  title: string
  summary: string
  content: string
  kind: 'fact' | 'preference' | 'constraint' | 'workflow'
  confidence: number
  observedAt: string
  tags: string[]
  evidence: string[]
}

export interface RSISkillCandidate {
  name: string
  summary: string
  trigger: string
  workflow: string[]
  confidence: number
  sourceObservationIds: string[]
  sourceSessionIds: string[]
}

export interface RSICheckpointDetail {
  sessionId: string
  updatedAt: string
  goal: string
  currentPlan: string[]
  constraints: string[]
  decisionsMade: string[]
  filesInPlay: string[]
  completedWork: string[]
  openLoops: string[]
  nextBestStep: string
  durableMemoryCandidates: RSIDurableMemoryCandidate[]
  skillCandidates: RSISkillCandidate[]
}

export interface RSIHistorySummary {
  sessionId: string
  updatedAt: string
  goal: string
  nextBestStep: string
  openLoopCount: number
  durableCandidateCount: number
  skillCandidateCount: number
}

export interface RsiHistoryResult {
  entries: RSIHistorySummary[]
  message?: string
}

export interface RsiCheckpointResult {
  checkpoint: RSICheckpointDetail | null
  message?: string
}

export interface EvolutionEntry {
  id: string
  timestamp: string
  type: string
  description: string
  sessionId?: string
  skillName?: string
  details?: Record<string, unknown>
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
  lease?: Omit<PermissionLeaseDisplayDetails, 'status'> & { status?: PermissionLeaseStatus }
  workerDiff?: WorkerDiffDisplayDetails
  /** Skill name when type === 'skill-activation'. */
  skillName?: string
}
export interface ApprovalListResult {
  approvals: ApprovalItem[]
}
export interface ApprovalRespondResult {
  status: string
  message?: string
  lease?: PermissionLeaseDisplayDetails
  workerDiff?: WorkerDiffDisplayDetails
  /** Set when responding to a skill-activation approval. */
  skillName?: string
}
export interface AskUserRespondResult {
  ok: boolean
}

export interface WorkspaceSetResult {
  directory: string
}
export interface WorkspaceClearResult {
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

// ── Artifacts ───────────────────────────────────────────────────────

export interface Artifact {
  artifactId: string
  version: number
  sessionId: string
  title: string
  description?: string
  path: string
  bytes: number
  createdAt: string
}

export interface ArtifactsListParams {
  sessionId: string
}
export interface ArtifactsListResult {
  artifacts: Artifact[]
}
export interface ArtifactsReadParams {
  sessionId: string
  artifactId: string
  version?: number
}
export interface ArtifactsReadResult {
  html: string
  artifact: Artifact
}

// ── Method Map (method name -> params & result types) ──────────────

export interface RpcMethodMap {
  'agent/run': { params: AgentRunParams; result: AgentRunResult }
  'agent/cancel': { params: AgentCancelParams; result: AgentCancelResult }
  'agent/steer': { params: AgentSteerParams; result: AgentSteerResult }
  'session/list': { params: SessionListParams; result: SessionListResult }
  'session/load': { params: SessionLoadParams; result: SessionData }
  'session/new': { params: SessionNewParams; result: SessionNewResult }
  'session/delete': { params: SessionDeleteParams; result: SessionDeleteResult }
  'session/rename': { params: SessionRenameParams; result: SessionRenameResult }
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
  'rsi/history': { params: RsiHistoryParams; result: RsiHistoryResult }
  'rsi/checkpoint': { params: RsiCheckpointParams; result: RsiCheckpointResult }
  'evolution/list': { params: EvolutionListParams; result: EvolutionListResult }
  'evolution/stats': { params: EvolutionStatsParams; result: EvolutionStatsResult }
  'approval/list': { params: ApprovalListParams; result: ApprovalListResult }
  'approval/respond': { params: ApprovalRespondParams; result: ApprovalRespondResult }
  'askUser/respond': { params: AskUserRespondParams; result: AskUserRespondResult }
  'workspace/set': { params: WorkspaceSetParams; result: WorkspaceSetResult }
  'workspace/clear': { params: WorkspaceClearParams; result: WorkspaceClearResult }
  'team/create': { params: TeamCreateParams; result: TeamGraphResult }
  'team/createWorkflow': { params: TeamCreateWorkflowParams; result: TeamGraphResult }
  'team/get': { params: TeamGraphParams; result: TeamGraphResult }
  'team/start': { params: TeamGraphParams; result: TeamGraphResult }
  'team/cancel': { params: TeamCancelParams; result: TeamGraphResult }
  'team/cleanup': { params: TeamGraphParams; result: TeamCleanupResult }
  'team/addTask': { params: TeamAddTaskParams; result: TeamAddTaskResult }
  'team/assignTask': { params: TeamAssignTaskParams; result: TeamAssignTaskResult }
  'team/sendMessage': { params: TeamSendMessageParams; result: TeamSendMessageResult }
  'mode/getState': { params: ModeGetStateParams; result: ModeState }
  'mode/enter': { params: ModeEnterParams; result: ModeEnterResult }
  'mode/exit': { params: ModeExitParams; result: ModeExitResult }
  'mode/getPlan': { params: ModeGetPlanParams; result: Plan | null }
  'artifacts/list': { params: ArtifactsListParams; result: ArtifactsListResult }
  'artifacts/read': { params: ArtifactsReadParams; result: ArtifactsReadResult }
  'mcp/list': { params: Record<string, never>; result: McpListResult }
  'mcp/restart': { params: McpRestartParams; result: McpRestartResult }
}

// ── MCP (Model Context Protocol) — desktop visibility types ────────

/** Lifecycle status of one MCP server. */
export type McpServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface McpServerEntry {
  name: string
  type: 'local' | 'remote'
  status: McpServerStatus
  toolCount: number
  errorMessage?: string
  pid?: number
}

export interface McpListResult {
  servers: McpServerEntry[]
}

export interface McpRestartParams {
  name: string
}

export interface McpRestartResult {
  ok: boolean
  errorMessage?: string
}

export type RpcMethod = keyof RpcMethodMap

/**
 * Runtime list of every RPC method name. Kept in sync with `RpcMethodMap`
 * by the compile-time assertions below. The CLI's `createHandlers()` must
 * register a handler for each of these names — enforced by
 * `protocol-contract.test.ts`.
 */
export const RPC_METHOD_NAMES = [
  'agent/run',
  'agent/cancel',
  'agent/steer',
  'session/list',
  'session/load',
  'session/new',
  'session/delete',
  'session/rename',
  'config/get',
  'config/set',
  'config/setApiKey',
  'config/testConnection',
  'auth/getStatus',
  'auth/startLogin',
  'auth/pollLogin',
  'auth/cancelLogin',
  'auth/logout',
  'skills/list',
  'skills/get',
  'rsi/dream',
  'rsi/status',
  'rsi/history',
  'rsi/checkpoint',
  'evolution/list',
  'evolution/stats',
  'approval/list',
  'approval/respond',
  'askUser/respond',
  'workspace/set',
  'workspace/clear',
  'team/create',
  'team/createWorkflow',
  'team/get',
  'team/start',
  'team/cancel',
  'team/cleanup',
  'team/addTask',
  'team/assignTask',
  'team/sendMessage',
  'mode/getState',
  'mode/enter',
  'mode/exit',
  'mode/getPlan',
  'artifacts/list',
  'artifacts/read',
  'mcp/list',
  'mcp/restart',
] as const satisfies readonly RpcMethod[]

/** Compile-time check that `RPC_METHOD_NAMES` covers every key of `RpcMethodMap`. */
type _RpcMethodCoverageCheck =
  Exclude<RpcMethod, (typeof RPC_METHOD_NAMES)[number]> extends never
    ? true
    : [
        'Missing RPC method in RPC_METHOD_NAMES:',
        Exclude<RpcMethod, (typeof RPC_METHOD_NAMES)[number]>,
      ]
const _rpcCoverage: _RpcMethodCoverageCheck = true
void _rpcCoverage

// ── Notification Types ─────────────────────────────────────────────
//
// The Notification types are wire envelopes for the *Params payload types
// above. They carry the same `sessionId` so the renderer can route
// concurrent runs from different sessions without UI crosstalk.

/**
 * Common base for notifications emitted while an agent run is in flight.
 * `sessionId` identifies which session (and therefore which agent) produced
 * the event. `null` means the event has no session attribution (e.g. a
 * skill activated before any session exists; events from older CLIs).
 */
export interface AgentRunSessionScoped {
  sessionId: string | null
}

export interface AgentTextNotification extends AgentTextParams {}
export interface AgentContextUsageNotification extends AgentContextUsageParams {}
export interface AgentToolCallStartNotification extends AgentRunSessionScoped {
  toolCallId: string
  toolName: string
  input: unknown
}
export interface AgentToolCallEndNotification extends AgentRunSessionScoped {
  toolCallId: string
  toolName: string
  result: unknown
  isError: boolean
}
export interface AgentTurnCompleteNotification extends AgentRunSessionScoped {
  text: string
  iterations: number
}
export interface AgentErrorNotification extends AgentRunSessionScoped {
  message: string
  recoverable?: boolean
}
export interface AgentSteerInjectedNotification extends AgentSteerInjectedParams {}
export interface AgentSteerOrphanedNotification extends AgentSteerOrphanedParams {}
export interface AgentTurnAbortedNotification extends AgentTurnAbortedParams {}
export interface AgentThinkingNotification extends AgentRunSessionScoped {
  text: string
}
export interface AgentStatusNotification extends AgentRunSessionScoped {
  status: string
  message?: string
}
export type SubagentRunStatus = 'running' | 'completed' | 'failed'
export interface SubagentLifecycleBaseNotification extends AgentRunSessionScoped {
  runId: string
  parentSessionId?: string
  childSessionId?: string
  agentId: string
  task: string
  status: SubagentRunStatus
  startedAt: string
}
export interface AgentSubagentStartedNotification extends SubagentLifecycleBaseNotification {
  status: 'running'
}
export interface AgentSubagentUpdatedNotification extends SubagentLifecycleBaseNotification {
  status: 'running'
  updatedAt: string
  message?: string
}
export interface AgentSubagentCompletedNotification extends SubagentLifecycleBaseNotification {
  status: 'completed'
  completedAt: string
  result: unknown
  workerDiff?: WorkerDiffDisplayDetails
}
export interface AgentSubagentFailedNotification extends SubagentLifecycleBaseNotification {
  status: 'failed'
  completedAt: string
  error: {
    message: string
  }
  result?: unknown
  workerDiff?: WorkerDiffDisplayDetails
}
export type AgentPermissionLeaseUpdatedNotification = PermissionLeaseDisplayDetails
export interface MemoryUpdatedNotification {
  topic: string
  action: 'created' | 'updated' | 'deleted'
}
export interface SkillActivatedNotification extends AgentRunSessionScoped {
  name: string
}
export interface ApprovalRequestNotification {
  id: string
  type: string
  description: string
  createdAt?: string
  risk?: 'high' | 'medium' | 'low'
  diff?: string
  lease?: Omit<PermissionLeaseDisplayDetails, 'status'> & { status?: PermissionLeaseStatus }
  workerDiff?: WorkerDiffDisplayDetails
}
export interface AskUserRequestNotification {
  id: string
  question: string
  options: string[]
  createdAt: string
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
  sessionId?: string | null
  plan: Plan
}

export interface AgentArtifactCreatedNotification extends AgentRunSessionScoped {
  artifactId: string
  version: number
  title: string
  description?: string
  path: string
  bytes: number
  createdAt: string
}

export interface McpServerConnectedNotification {
  name: string
  toolCount: number
}

export interface McpServerDisconnectedNotification {
  name: string
  reason?: string
}

export interface McpServerErrorNotification {
  name: string
  message: string
  willRetry: boolean
}

export interface NotificationMap {
  'agent/contextUsage': AgentContextUsageNotification
  'agent/text': AgentTextNotification
  'agent/toolCallStart': AgentToolCallStartNotification
  'agent/toolCallEnd': AgentToolCallEndNotification
  'agent/turnComplete': AgentTurnCompleteNotification
  'agent/error': AgentErrorNotification
  'agent/steerInjected': AgentSteerInjectedNotification
  'agent/steerOrphaned': AgentSteerOrphanedNotification
  'agent/turnAborted': AgentTurnAbortedNotification
  'agent/thinking': AgentThinkingNotification
  'agent/status': AgentStatusNotification
  'agent/subagentStarted': AgentSubagentStartedNotification
  'agent/subagentUpdated': AgentSubagentUpdatedNotification
  'agent/subagentCompleted': AgentSubagentCompletedNotification
  'agent/subagentFailed': AgentSubagentFailedNotification
  'agent/permissionLeaseUpdated': AgentPermissionLeaseUpdatedNotification
  'team/graphOpen': TeamGraphNotification
  'team/graphUpdated': TeamGraphNotification
  'memory/updated': MemoryUpdatedNotification
  'skill/activated': SkillActivatedNotification
  'approval/request': ApprovalRequestNotification
  'askUser/request': AskUserRequestNotification
  'rsi/reflection': RsiReflectionNotification
  'rsi/crystallization': RsiCrystallizationNotification
  'rsi/dream': RsiDreamNotification
  'rsi/error': RsiErrorNotification
  'rsi/runtime': RsiRuntimeNotification
  'mode/entered': ModeEnteredNotification
  'mode/exited': ModeExitedNotification
  'mode/planSubmitted': ModePlanSubmittedNotification
  'agent/artifactCreated': AgentArtifactCreatedNotification
  'mcp/serverConnected': McpServerConnectedNotification
  'mcp/serverDisconnected': McpServerDisconnectedNotification
  'mcp/serverError': McpServerErrorNotification
}

export type NotificationMethod = keyof NotificationMap

/**
 * Runtime list of every CLI-emitted notification method. The CLI must only
 * emit notifications with names in this list — enforced by
 * `protocol-contract.test.ts`, which greps the CLI source for every
 * `makeNotification(...)` call site.
 */
export const NOTIFICATION_METHOD_NAMES = [
  'agent/contextUsage',
  'agent/text',
  'agent/toolCallStart',
  'agent/toolCallEnd',
  'agent/turnComplete',
  'agent/error',
  'agent/steerInjected',
  'agent/steerOrphaned',
  'agent/turnAborted',
  'agent/thinking',
  'agent/status',
  'agent/subagentStarted',
  'agent/subagentUpdated',
  'agent/subagentCompleted',
  'agent/subagentFailed',
  'agent/permissionLeaseUpdated',
  'team/graphOpen',
  'team/graphUpdated',
  'memory/updated',
  'skill/activated',
  'approval/request',
  'askUser/request',
  'rsi/reflection',
  'rsi/crystallization',
  'rsi/dream',
  'rsi/error',
  'rsi/runtime',
  'mode/entered',
  'mode/exited',
  'mode/planSubmitted',
  'agent/artifactCreated',
  'mcp/serverConnected',
  'mcp/serverDisconnected',
  'mcp/serverError',
] as const satisfies readonly NotificationMethod[]

/** Compile-time check that `NOTIFICATION_METHOD_NAMES` covers every key of `NotificationMap`. */
type _NotificationCoverageCheck =
  Exclude<NotificationMethod, (typeof NOTIFICATION_METHOD_NAMES)[number]> extends never
    ? true
    : [
        'Missing notification method in NOTIFICATION_METHOD_NAMES:',
        Exclude<NotificationMethod, (typeof NOTIFICATION_METHOD_NAMES)[number]>,
      ]
const _notificationCoverage: _NotificationCoverageCheck = true
void _notificationCoverage

// ── IPC Channel Constants ──────────────────────────────────────────

export const IPC_CHANNELS = {
  RPC_REQUEST: 'ouroboros:rpc-request',
  CLI_NOTIFICATION: 'ouroboros:cli-notification',
  CLI_STATUS: 'ouroboros:cli-status',
  SHOW_OPEN_DIALOG: 'ouroboros:show-open-dialog',
  VALIDATE_IMAGE_ATTACHMENTS: 'ouroboros:validate-image-attachments',
  SAVE_ARTIFACT: 'ouroboros:save-artifact',
} as const
