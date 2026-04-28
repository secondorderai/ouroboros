import { create } from 'zustand'
import type {
  Message,
  ImageAttachment,
  ToolCallState,
  CompletedToolCall,
  AgentTextParams,
  AgentContextUsageParams,
  AgentToolCallStartParams,
  AgentToolCallEndParams,
  AgentTurnCompleteParams,
  AgentErrorParams,
  AgentSteerInjectedNotification,
  AgentSteerOrphanedNotification,
  AgentTurnAbortedNotification,
  AgentSubagentStartedNotification,
  AgentSubagentUpdatedNotification,
  AgentSubagentCompletedNotification,
  AgentSubagentFailedNotification,
  AgentPermissionLeaseUpdatedNotification,
  SessionInfo,
  SessionMessage,
  SubagentEvidenceReference,
  SubagentRun,
  PermissionLeaseDisplayDetails,
  WorkerDiffDisplayDetails,
  WorkspaceMode,
} from '../../shared/protocol'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * All session-scoped run state — what's shown in the chat for a particular
 * session. Stored per-session in `sessionRunSnapshots` so that switching
 * away from a mid-stream session preserves its messages, partial reply,
 * and pending tool calls; switching back restores them. The flat
 * `messages`/`streamingText`/etc. fields below are a mirror of the
 * currently-viewed snapshot (kept for component code that reads flat state).
 */
export interface SessionRunSnapshot {
  messages: Message[]
  streamingText: string | null
  activeToolCalls: Map<string, ToolCallState>
  pendingToolCalls: CompletedToolCall[]
  pendingSubagentRuns: SubagentRun[]
  pendingActivatedSkills: string[]
  isAgentRunning: boolean
  contextUsage: AgentContextUsageParams | null
  nextId: number
}

export interface ConversationState {
  /** Ordered list of completed messages in the current conversation. */
  messages: Message[]

  /** Text being streamed for the current agent turn (null when idle). */
  streamingText: string | null

  /** Tool calls currently in progress during the active agent turn. */
  activeToolCalls: Map<string, ToolCallState>

  /** Completed tool calls accumulated during the current agent turn. */
  pendingToolCalls: CompletedToolCall[]

  /** Subagent runs accumulated during the current agent turn. */
  pendingSubagentRuns: SubagentRun[]

  /** Skill names activated during the current agent turn (deduped, in order
   * of activation). Seeded by sendMessage when the user picks a slash skill,
   * extended by handleSkillActivated for mid-turn LLM activations, drained
   * into the new agent message at handleTurnComplete. */
  pendingActivatedSkills: string[]

  /** Whether the agent is currently executing a turn. */
  isAgentRunning: boolean

  /** Session currently owning the active agent run, if any. */
  activeRunSessionId: string | null

  /** ID counter for generating unique message IDs. */
  nextId: number

  /** Current session ID (null when no session is active). */
  currentSessionId: string | null

  /**
   * Per-session snapshot of run state. Notifications for non-current sessions
   * update this map directly so switching back later shows the latest state
   * (including any in-flight streaming text or pending tool calls). The
   * currently-viewed session's snapshot is mirrored to the flat fields above.
   */
  sessionRunSnapshots: Map<string, SessionRunSnapshot>

  /** List of all sessions for the sidebar. */
  sessions: SessionInfo[]

  /** Current workspace path. */
  workspace: string | null

  /** Workspace mode used when creating new sessions. */
  workspaceMode: WorkspaceMode

  /** Folder selected for new Workspace-mode sessions. */
  selectedWorkspacePath: string | null

  /** User-visible workspace mode validation error. */
  workspaceModeError: string | null

  /** Current model name. */
  modelName: string | null

  /** Current estimated context usage for the active conversation. */
  contextUsage: AgentContextUsageParams | null

  // -- Actions ---------------------------------------------------------------

  /** User sends a message. Adds the message to the list and marks agent as running. */
  sendMessage: (
    text: string,
    files?: string[],
    images?: ImageAttachment[],
    skillName?: string,
  ) => void

  /**
   * Inject a "steer" message into the in-flight agent run. Only valid while
   * `isAgentRunning === true`. The message is optimistically added to the
   * transcript with `kind: 'steer'` and `steerStatus: 'pending'`, then sent
   * over RPC; the status flips to `'injected'` (next iteration drained it),
   * `'orphaned'` (run ended before injection), or back to a normal failure
   * if the CLI rejects the steer.
   */
  steerCurrentRun: (text: string, images?: ImageAttachment[]) => void

  /** Resend an orphaned steer as a brand-new user message + new agent run. */
  resendOrphanedSteer: (steerRequestId: string) => void

  /** Hide an orphaned steer banner without resending. */
  dismissOrphanedSteer: (steerRequestId: string) => void

  /** Cancel the current agent run. */
  cancelRun: () => void

  /** Handle an incoming `agent/text` notification. */
  handleAgentText: (params: AgentTextParams) => void

  /** Handle an incoming `agent/contextUsage` notification. */
  handleContextUsage: (params: AgentContextUsageParams) => void

  /** Handle an incoming `agent/toolCallStart` notification. */
  handleToolCallStart: (params: AgentToolCallStartParams) => void

  /** Handle an incoming `agent/toolCallEnd` notification. */
  handleToolCallEnd: (params: AgentToolCallEndParams) => void

  /** Handle an incoming `agent/turnComplete` notification. */
  handleTurnComplete: (params: AgentTurnCompleteParams) => void

  /** Handle an incoming `skill/activated` notification — dedupes by name. */
  handleSkillActivated: (params: { name: string; sessionId?: string | null }) => void

  /** Handle an incoming `agent/error` notification. */
  handleAgentError: (params: AgentErrorParams) => void

  /** Handle an incoming `agent/steerInjected` notification. */
  handleSteerInjected: (params: AgentSteerInjectedNotification) => void

  /** Handle an incoming `agent/steerOrphaned` notification. */
  handleSteerOrphaned: (params: AgentSteerOrphanedNotification) => void

  /** Handle an incoming `agent/turnAborted` notification. */
  handleTurnAborted: (params: AgentTurnAbortedNotification) => void

  /** Handle an incoming `agent/subagentStarted` notification. */
  handleSubagentStarted: (params: AgentSubagentStartedNotification) => void

  /** Handle an incoming `agent/subagentUpdated` notification. */
  handleSubagentUpdated: (params: AgentSubagentUpdatedNotification) => void

  /** Handle an incoming `agent/subagentCompleted` notification. */
  handleSubagentCompleted: (params: AgentSubagentCompletedNotification) => void

  /** Handle an incoming `agent/subagentFailed` notification. */
  handleSubagentFailed: (params: AgentSubagentFailedNotification) => void

  /** Handle an incoming `agent/permissionLeaseUpdated` notification. */
  handlePermissionLeaseUpdated: (params: AgentPermissionLeaseUpdatedNotification) => void

  /** Handle worker diff approval status updates. */
  handleWorkerDiffUpdated: (params: WorkerDiffDisplayDetails) => void

  /** Reset the conversation (e.g., when switching sessions). */
  resetConversation: () => void

  /** Set the list of sessions from the sidebar. */
  setSessions: (sessions: SessionInfo[]) => void

  /** Set the current session ID. */
  setCurrentSessionId: (id: string | null) => void

  /** Load a session's messages into the chat. */
  loadSession: (
    id: string,
    messages: SessionMessage[],
    workspacePath?: string | null,
    workspaceMode?: WorkspaceMode,
  ) => void

  /** Create a new session and make it active. */
  createNewSession: (
    sessionId: string,
    workspacePath?: string | null,
    workspaceMode?: WorkspaceMode,
  ) => void

  /** Delete a session from the list. */
  deleteSession: (id: string) => void

  /** Rename a session in the sidebar. */
  renameSession: (id: string, title: string) => void

  /** Set the workspace path. */
  setWorkspace: (path: string | null) => void

  /** Set the workspace mode for new sessions. */
  setWorkspaceMode: (mode: WorkspaceMode) => void

  /** Set the folder used for new Workspace-mode sessions. */
  setSelectedWorkspacePath: (path: string | null) => void

  /** Clear workspace mode validation error. */
  clearWorkspaceModeError: () => void

  /** Set the model name. */
  setModelName: (name: string | null) => void

  /** Current reasoning effort level for the active model (if supported). */
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'max' | null

  /** Set the reasoning effort level. */
  setReasoningEffort: (effort: 'minimal' | 'low' | 'medium' | 'high' | 'max' | null) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string, n: number): string {
  return `${prefix}-${n}`
}

/**
 * Determine which session a notification belongs to.
 *
 * Modern CLIs stamp `sessionId` on every agent/* notification so the renderer
 * can route concurrent runs without crosstalk. When the field is absent
 * (older CLI binaries, or events that fire outside any session), we fall
 * back to the single-run `activeRunSessionId` set by `sendMessage`.
 */
function resolveRunSessionId(
  params: { sessionId?: string | null },
  state: { activeRunSessionId: string | null },
): string | null {
  if (typeof params.sessionId === 'string' && params.sessionId.length > 0) {
    return params.sessionId
  }
  return state.activeRunSessionId
}

// --- Per-session snapshot helpers ------------------------------------------

function emptySnapshot(): SessionRunSnapshot {
  return {
    messages: [],
    streamingText: null,
    activeToolCalls: new Map(),
    pendingToolCalls: [],
    pendingSubagentRuns: [],
    pendingActivatedSkills: [],
    isAgentRunning: false,
    contextUsage: null,
    nextId: 1,
  }
}

/** Extract the run-scoped fields from a flat ConversationState. */
function snapshotFromFlat(state: ConversationState): SessionRunSnapshot {
  return {
    messages: state.messages,
    streamingText: state.streamingText,
    activeToolCalls: state.activeToolCalls,
    pendingToolCalls: state.pendingToolCalls,
    pendingSubagentRuns: state.pendingSubagentRuns,
    pendingActivatedSkills: state.pendingActivatedSkills,
    isAgentRunning: state.isAgentRunning,
    contextUsage: state.contextUsage,
    nextId: state.nextId,
  }
}

/** Translate a snapshot back into the flat fields the UI components read. */
function flatFromSnapshot(snap: SessionRunSnapshot): {
  messages: Message[]
  streamingText: string | null
  activeToolCalls: Map<string, ToolCallState>
  pendingToolCalls: CompletedToolCall[]
  pendingSubagentRuns: SubagentRun[]
  pendingActivatedSkills: string[]
  isAgentRunning: boolean
  contextUsage: AgentContextUsageParams | null
  nextId: number
} {
  return {
    messages: snap.messages,
    streamingText: snap.streamingText,
    activeToolCalls: snap.activeToolCalls,
    pendingToolCalls: snap.pendingToolCalls,
    pendingSubagentRuns: snap.pendingSubagentRuns,
    pendingActivatedSkills: snap.pendingActivatedSkills,
    isAgentRunning: snap.isAgentRunning,
    contextUsage: snap.contextUsage,
    nextId: snap.nextId,
  }
}

/**
 * Apply a per-session run-state update.
 *
 * - When `sessionId` is the currently-viewed session, the update lands on the
 *   flat `messages`/`streamingText`/etc. fields AND in the snapshot map so
 *   future view-switches restore correctly.
 * - When `sessionId` is some other session, only the snapshot map is touched —
 *   the visible UI for the current session is unaffected, but the background
 *   session's state keeps accumulating so that switching to it later shows
 *   the latest streaming/tool-call/turn state.
 *
 * The `updater` is called on the session's current snapshot (or an empty
 * snapshot if it doesn't exist yet) and must return the next snapshot.
 */
function updateRunState(
  state: ConversationState,
  sessionId: string,
  updater: (snap: SessionRunSnapshot) => SessionRunSnapshot,
): Partial<ConversationState> {
  const snapshots = new Map(state.sessionRunSnapshots)
  const currentSnap =
    sessionId === state.currentSessionId
      ? snapshotFromFlat(state)
      : (snapshots.get(sessionId) ?? emptySnapshot())
  const next = updater(currentSnap)
  snapshots.set(sessionId, next)

  if (sessionId === state.currentSessionId) {
    return {
      sessionRunSnapshots: snapshots,
      ...flatFromSnapshot(next),
    }
  }
  return { sessionRunSnapshots: snapshots }
}

function toSentenceCase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function finalizeSessionTitle(input: string): string {
  const maxChars = 42
  const words = input
    .replace(/[?.!,;:]+(?=\s|$)/g, '')
    .split(/\s+/)
    .filter(Boolean)
  const limitedWords = words.slice(0, 6).join(' ')
  const candidate =
    limitedWords.length > maxChars
      ? limitedWords.slice(0, maxChars).replace(/\s+\S*$/, '')
      : limitedWords

  return candidate || 'New conversation'
}

function deriveCompletedSessionTitle(userInput: string, assistantResponse?: string): string {
  const initialTitle = deriveSessionTitle(userInput)
  const isWeakInitialTitle =
    initialTitle === 'New conversation' ||
    /^(?:Implement|Update|Fix|Add|Build|Create|Help|Please|Can you|Could you)\b/i.test(
      initialTitle,
    ) ||
    /\b(?:option|recommended direction|above|this|that)\b/i.test(initialTitle)

  if (!assistantResponse || !isWeakInitialTitle) return initialTitle

  const assistantTitle = deriveTitleFromAssistantResponse(assistantResponse)
  return assistantTitle && assistantTitle !== 'New conversation' ? assistantTitle : initialTitle
}

function deriveTitleFromAssistantResponse(response: string): string | undefined {
  const text = response.trim().replace(/\s+/g, ' ')
  if (!text) return undefined

  const matchers: Array<[RegExp, (...matches: string[]) => string]> = [
    [
      /\b(?:implemented|added|built|created|updated|fixed|wired|renamed)\s+(?:the\s+)?(.+?)(?:\.|,|;|\band\b|\bwith\b|\bso\b|$)/i,
      (subject) => toSentenceCase(subject),
    ],
    [
      /\b(?:this|the)\s+change\s+(?:adds|updates|fixes|implements)\s+(.+?)(?:\.|,|;|\band\b|\bwith\b|\bso\b|$)/i,
      (subject) => toSentenceCase(subject),
    ],
  ]

  for (const [pattern, formatter] of matchers) {
    const match = text.match(pattern)
    if (match) {
      const title = finalizeSessionTitle(cleanTitleSubject(formatter(...match.slice(1))))
      if (title !== 'New conversation') return title
    }
  }

  return undefined
}

function cleanTitleSubject(input: string): string {
  return input
    .replace(/\b(?:support|path|flow|feature)\b$/i, '')
    .replace(/\b(?:in|to|for|from|with|by)\s*$/i, '')
    .trim()
}

function deriveSessionTitle(input: string): string {
  let text = input.trim().replace(/\s+/g, ' ')
  if (!text) return 'New conversation'

  text = text
    .replace(/^(?:[#>*-]+\s*)+/, '')
    .replace(/^(?:\/[\w-]+\s+)+/i, '')
    .replace(/^without web search,?\s*/i, '')
    .replace(/^(?:plan|task|question)\s+/i, '')

  const matchers: Array<[RegExp, (...matches: string[]) => string]> = [
    [/^create (?:a )?plan to (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^plan for (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^implement (.+)$/i, (subject) => toSentenceCase(subject)],
    [/^(?:fix|add|build|update|improve|refactor) (.+)$/i, (subject) => toSentenceCase(subject)],
    [/^what are the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [/^what is the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [
      /^what materials are good for use in (.+)$/i,
      (subject) => `${toSentenceCase(subject)} materials`,
    ],
    [/^what materials are good for (.+)$/i, (subject) => `${toSentenceCase(subject)} materials`],
    [/^how to (.+)$/i, (subject) => toSentenceCase(subject)],
  ]

  for (const [pattern, formatter] of matchers) {
    const match = text.match(pattern)
    if (match) {
      return finalizeSessionTitle(
        formatter(...match.slice(1))
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
  }

  text = text
    .replace(/^(?:can you|could you|would you|please|help me|i need to)\s+/i, '')
    .replace(/\bto follow\b/gi, '')
    .replace(/\s+(?:and|or)\s+/gi, ' / ')
    .trim()

  return finalizeSessionTitle(toSentenceCase(text))
}

export function normalizeTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''

  if (Array.isArray(value)) {
    const text = value
      .map((item) => normalizeTextContent(item))
      .filter(Boolean)
      .join('')
    if (text) return text
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>

    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    if (typeof record.message === 'string') return record.message
    if (typeof record.value === 'string') return record.value

    if (typeof record.type === 'string') {
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      if (record.type === 'text' && typeof record.value === 'string') return record.value
    }

    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) => normalizeTextContent(item))
        .filter(Boolean)
        .join('')
      if (text) return text
    }

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  return String(value)
}

export function normalizeToolName(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (typeof value === 'object' && value != null) {
    const record = value as Record<string, unknown>
    const candidate = record.toolName ?? record.name ?? record.id ?? record.type
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }

  const fallback = normalizeTextContent(value).trim()
  return fallback || 'unknown'
}

function stripImagePreviewData(image: ImageAttachment): ImageAttachment {
  const { previewDataUrl: _previewDataUrl, ...metadata } = image
  return metadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function labelEvidence(evidence: Record<string, unknown>): SubagentEvidenceReference | null {
  const type = evidence.type
  if (type === 'file') {
    const path = getStringField(evidence, 'path')
    if (!path) return null
    const line = getNumberField(evidence, 'line')
    const endLine = getNumberField(evidence, 'endLine')
    const suffix =
      line == null ? '' : endLine != null && endLine !== line ? `:${line}-${endLine}` : `:${line}`
    return { type: 'file', label: `${path}${suffix}`, path, line, endLine }
  }
  if (type === 'command') {
    const command = getStringField(evidence, 'command')
    if (!command) return null
    return { type: 'command', label: command }
  }
  if (type === 'output') {
    const excerpt = getStringField(evidence, 'excerpt')
    if (!excerpt) return null
    return {
      type: 'output',
      label: excerpt.length > 48 ? `${excerpt.slice(0, 45)}...` : excerpt,
    }
  }
  return null
}

function extractSubagentResult(result: unknown): {
  summary?: string
  evidenceCount: number
  uncertaintyCount: number
  evidence: SubagentEvidenceReference[]
} {
  if (!isRecord(result)) {
    return { evidenceCount: 0, uncertaintyCount: 0, evidence: [] }
  }

  const summary = getStringField(result, 'summary')
  const claims = Array.isArray(result.claims) ? result.claims : []
  const uncertainty = Array.isArray(result.uncertainty) ? result.uncertainty : []
  const evidence: SubagentEvidenceReference[] = []
  let evidenceCount = 0

  for (const claim of claims) {
    if (!isRecord(claim) || !Array.isArray(claim.evidence)) continue
    for (const item of claim.evidence) {
      if (!isRecord(item)) continue
      evidenceCount += 1
      const reference = labelEvidence(item)
      if (reference) evidence.push(reference)
    }
  }

  return {
    summary,
    evidenceCount,
    uncertaintyCount: uncertainty.length,
    evidence,
  }
}

function extractWorkerDiff(
  result: unknown,
  notificationWorkerDiff: WorkerDiffDisplayDetails | undefined,
): WorkerDiffDisplayDetails | undefined {
  if (notificationWorkerDiff) return notificationWorkerDiff
  if (!isRecord(result) || !isRecord(result.workerDiff)) return undefined
  return result.workerDiff as unknown as WorkerDiffDisplayDetails
}

function createSubagentRun(params: AgentSubagentStartedNotification): SubagentRun {
  return createSubagentRunBase(params)
}

function createSubagentRunBase(params: {
  runId: string
  parentSessionId?: string
  childSessionId?: string
  agentId: string
  task: string
  startedAt: string
}): SubagentRun {
  return {
    runId: params.runId,
    parentSessionId: params.parentSessionId,
    childSessionId: params.childSessionId,
    agentId: params.agentId,
    task: params.task,
    status: 'running',
    startedAt: params.startedAt,
    evidenceCount: 0,
    uncertaintyCount: 0,
    evidence: [],
    permissionLeases: [],
  }
}

function isSameWorkerDiff(
  existing: WorkerDiffDisplayDetails | undefined,
  incoming: WorkerDiffDisplayDetails,
): boolean {
  if (!existing) return false
  return (
    existing.taskId === incoming.taskId &&
    (!incoming.worktreePath || existing.worktreePath === incoming.worktreePath)
  )
}

function upsertSubagentRun(runs: SubagentRun[], run: SubagentRun): SubagentRun[] {
  const index = runs.findIndex((item) => item.runId === run.runId)
  if (index === -1) return [...runs, run]
  const next = [...runs]
  next[index] = { ...next[index], ...run }
  return next
}

function updateSubagentRun(
  runs: SubagentRun[],
  runId: string,
  update: (run: SubagentRun) => SubagentRun,
): SubagentRun[] {
  let changed = false
  const next = runs.map((run) => {
    if (run.runId !== runId) return run
    changed = true
    return update(run)
  })
  return changed ? next : runs
}

function updateMessageSubagentRun(
  messages: Message[],
  runId: string,
  update: (run: SubagentRun) => SubagentRun,
): { messages: Message[]; changed: boolean } {
  let changed = false
  const nextMessages = messages.map((message) => {
    if (!message.subagentRuns?.some((run) => run.runId === runId)) return message
    changed = true
    return {
      ...message,
      subagentRuns: updateSubagentRun(message.subagentRuns, runId, update),
    }
  })
  return { messages: nextMessages, changed }
}

function upsertPermissionLease(
  leases: PermissionLeaseDisplayDetails[] | undefined,
  lease: PermissionLeaseDisplayDetails,
): PermissionLeaseDisplayDetails[] {
  const existing = leases ?? []
  const index = existing.findIndex((item) => item.leaseId === lease.leaseId)
  if (index === -1) return [...existing, lease]
  const next = [...existing]
  next[index] = { ...next[index], ...lease }
  return next
}

function appendSubagentRunToLatestAgentMessage(
  messages: Message[],
  run: SubagentRun,
): { messages: Message[]; changed: boolean } {
  const index = [...messages].reverse().findIndex((message) => message.role === 'agent')
  if (index === -1) return { messages, changed: false }

  const messageIndex = messages.length - 1 - index
  const message = messages[messageIndex]
  const next = [...messages]
  next[messageIndex] = {
    ...message,
    subagentRuns: upsertSubagentRun(message.subagentRuns ?? [], run),
  }
  return { messages: next, changed: true }
}

/**
 * Apply a per-subagent-run updater across every session's snapshot AND the
 * flat current-session state. Used by global notifications like
 * permission-lease and worker-diff updates that don't carry a sessionId —
 * the update must reach whichever session owns the matching subagent run.
 *
 * `runId` is optional: when provided, only pendingSubagentRuns matching that
 * id are touched (other entries pass through). When undefined, the updater
 * runs over every subagent run (used by worker-diff which matches via
 * isSameWorkerDiff inside the updater).
 */
function applyAcrossAllSessions(
  state: ConversationState,
  runId: string | undefined,
  updater: (run: SubagentRun) => SubagentRun,
): Partial<ConversationState> {
  const transformSnap = (snap: SessionRunSnapshot): SessionRunSnapshot => {
    const pending = runId
      ? updateSubagentRun(snap.pendingSubagentRuns, runId, updater)
      : snap.pendingSubagentRuns.map(updater)
    let messagesChanged = false
    const messages = snap.messages.map((message) => {
      if (!message.subagentRuns) return message
      const nextRuns = runId
        ? message.subagentRuns.map((run) => (run.runId === runId ? updater(run) : run))
        : message.subagentRuns.map(updater)
      if (nextRuns.some((run, index) => run !== message.subagentRuns?.[index])) {
        messagesChanged = true
        return { ...message, subagentRuns: nextRuns }
      }
      return message
    })
    return {
      ...snap,
      pendingSubagentRuns: pending,
      messages: messagesChanged ? messages : snap.messages,
    }
  }

  const snapshots = new Map<string, SessionRunSnapshot>()
  for (const [id, snap] of state.sessionRunSnapshots) {
    snapshots.set(id, transformSnap(snap))
  }

  // The flat current-session state isn't in the snapshot map until the user
  // switches away — also apply directly to it.
  if (state.currentSessionId) {
    const currentSnap = transformSnap(snapshotFromFlat(state))
    snapshots.set(state.currentSessionId, currentSnap)
    return {
      sessionRunSnapshots: snapshots,
      ...flatFromSnapshot(currentSnap),
    }
  }
  return { sessionRunSnapshots: snapshots }
}

/**
 * Resolve which session a subagent notification belongs to. Prefer the
 * unconditional `sessionId` stamped by the CLI bridge; fall back to the
 * older `parentSessionId` for compatibility, then to whichever session is
 * currently driving the global activeRunSessionId.
 */
function resolveSubagentSessionId(
  notification: { sessionId?: string | null; parentSessionId?: string },
  state: ConversationState,
): string | null {
  if (typeof notification.sessionId === 'string' && notification.sessionId.length > 0) {
    return notification.sessionId
  }
  if (notification.parentSessionId) return notification.parentSessionId
  return state.activeRunSessionId
}

/**
 * Apply a subagent run update to a session snapshot. Tries pendingSubagentRuns
 * first (run is mid-turn), then falls back to retroactively updating an
 * already-finalized assistant message (run completes after turn-complete).
 */
function applySubagentUpdate(
  snap: SessionRunSnapshot,
  runId: string,
  updater: (run: SubagentRun) => SubagentRun,
  base: AgentSubagentStartedNotification | AgentSubagentUpdatedNotification | AgentSubagentCompletedNotification | AgentSubagentFailedNotification,
): SessionRunSnapshot {
  const pending = updateSubagentRun(snap.pendingSubagentRuns, runId, updater)
  if (pending !== snap.pendingSubagentRuns) {
    return { ...snap, pendingSubagentRuns: pending }
  }

  const messageUpdate = updateMessageSubagentRun(snap.messages, runId, updater)
  if (messageUpdate.changed) return { ...snap, messages: messageUpdate.messages }

  // Run was never seen before — synthesize one and either attach to the
  // most-recent assistant message (if the turn finished) or stash in pending.
  const run = updater(createSubagentRunBase(base))
  if (!snap.isAgentRunning) {
    const append = appendSubagentRunToLatestAgentMessage(snap.messages, run)
    if (append.changed) return { ...snap, messages: append.messages }
  }
  return { ...snap, pendingSubagentRuns: upsertSubagentRun(snap.pendingSubagentRuns, run) }
}

type StoreSet = (
  partial: Partial<ConversationState> | ((state: ConversationState) => Partial<ConversationState>),
) => void

type StoreGet = () => ConversationState

/**
 * Re-read image bytes off disk so messages loaded from a persisted session can
 * render their previews again — the transcript only stores path/metadata.
 */
function hydrateLoadedImagePreviews(
  sessionId: string,
  messages: Message[],
  set: StoreSet,
  get: StoreGet,
): void {
  const paths = Array.from(
    new Set(
      messages.flatMap((m) =>
        (m.imageAttachments ?? []).filter((img) => !img.previewDataUrl).map((img) => img.path),
      ),
    ),
  )
  if (paths.length === 0) return
  const api = typeof window !== 'undefined' ? window.ouroboros : undefined
  if (!api?.validateImageAttachments) return

  api
    .validateImageAttachments(paths)
    .then((result) => {
      if (result.accepted.length === 0) return
      const previewByPath = new Map(
        result.accepted
          .filter((img): img is ImageAttachment & { previewDataUrl: string } =>
            Boolean(img.previewDataUrl),
          )
          .map((img) => [img.path, img.previewDataUrl]),
      )
      if (previewByPath.size === 0) return
      if (get().currentSessionId !== sessionId) return

      set((state) => {
        if (state.currentSessionId !== sessionId) return state
        let anyChanged = false
        const next = state.messages.map((msg) => {
          if (!msg.imageAttachments?.length) return msg
          let changed = false
          const hydrated = msg.imageAttachments.map((img) => {
            if (img.previewDataUrl) return img
            const preview = previewByPath.get(img.path)
            if (!preview) return img
            changed = true
            return { ...img, previewDataUrl: preview }
          })
          if (!changed) return msg
          anyChanged = true
          return { ...msg, imageAttachments: hydrated }
        })
        return anyChanged ? { messages: next } : state
      })
    })
    .catch((err) => {
      console.error('validateImageAttachments (session load) failed:', err)
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationStore = create<ConversationState>((set, get) => ({
  messages: [],
  streamingText: null,
  activeToolCalls: new Map(),
  pendingToolCalls: [],
  pendingSubagentRuns: [],
  pendingActivatedSkills: [],
  isAgentRunning: false,
  activeRunSessionId: null,
  nextId: 1,
  currentSessionId: null,
  sessionRunSnapshots: new Map(),
  sessions: [],
  workspace: null,
  workspaceMode: 'simple',
  selectedWorkspacePath: null,
  workspaceModeError: null,
  modelName: null,
  reasoningEffort: null,
  contextUsage: null,

  // ---- Actions -------------------------------------------------------------

  sendMessage(text: string, files?: string[], images?: ImageAttachment[], skillName?: string) {
    const state = get()
    const runSessionId = state.currentSessionId
    if (!runSessionId && state.workspaceMode === 'workspace' && !state.selectedWorkspacePath) {
      set({ workspaceModeError: 'Select a workspace folder before starting a Workspace chat.' })
      return
    }
    const id = makeId('user', state.nextId)
    const sentAt = new Date().toISOString()
    const userMessage: Message = {
      id,
      role: 'user',
      text,
      timestamp: sentAt,
      files,
      imageAttachments: images,
    }

    set({
      messages: [...state.messages, userMessage],
      isAgentRunning: true,
      activeRunSessionId: runSessionId,
      streamingText: '',
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      pendingSubagentRuns: [],
      // Seed with the slash-picker selection so the chip shows even if the
      // skill/activated notification is delayed. handleSkillActivated dedupes
      // by name when the notification eventually arrives.
      pendingActivatedSkills: skillName ? [skillName] : [],
      nextId: state.nextId + 1,
      contextUsage: null,
      sessions: runSessionId
        ? state.sessions.map((s) => {
            if (s.id !== runSessionId) return s
            const title =
              s.title && s.title !== 'New conversation'
                ? s.title
                : deriveSessionTitle(text)
            return {
              ...s,
              title,
              titleSource: 'auto' as const,
              runStatus: 'running' as const,
              activeToolName: undefined,
              lastActive: sentAt,
            }
          })
        : state.sessions,
    })

    // Fire-and-forget RPC call to start the agent run.
    // The IPC bridge (window.ouroboros) may not be available in unit tests.
    void (async () => {
      let sessionId = runSessionId
      const api = window.ouroboros

      if (!sessionId && api) {
        const latest = get()
        const sessionParams =
          latest.workspaceMode === 'workspace'
            ? {
                workspaceMode: 'workspace' as const,
                workspacePath: latest.selectedWorkspacePath ?? undefined,
              }
            : { workspaceMode: 'simple' as const }
        const result = (await api.rpc('session/new', sessionParams)) as {
          sessionId?: string
          workspacePath?: string | null
          workspaceMode?: WorkspaceMode
        }
        if (result?.sessionId) {
          sessionId = result.sessionId
          const title = deriveSessionTitle(text)
          const now = new Date().toISOString()

          set((state) => {
            const session: SessionInfo = {
              id: result.sessionId!,
              createdAt: now,
              lastActive: now,
              messageCount: state.messages.length,
              title,
              titleSource: 'auto',
              workspacePath: result.workspacePath,
              workspaceMode: result.workspaceMode,
              runStatus: 'running',
            }
            const existing = state.sessions.some((item) => item.id === result.sessionId)
            return {
              currentSessionId: state.currentSessionId ?? result.sessionId,
              activeRunSessionId: result.sessionId,
              workspace: result.workspacePath ?? state.workspace,
              sessions: existing
                ? state.sessions.map((item) =>
                    item.id === result.sessionId
                      ? {
                          ...item,
                          title:
                            item.title && item.title !== 'New conversation' ? item.title : title,
                          titleSource: item.titleSource ?? 'auto',
                          workspacePath: result.workspacePath ?? item.workspacePath,
                          workspaceMode: result.workspaceMode ?? item.workspaceMode,
                          messageCount: state.messages.length,
                          lastActive: now,
                          runStatus: 'running',
                          activeToolName: undefined,
                        }
                      : item,
                  )
                : [session, ...state.sessions],
            }
          })
        }
      }

      await api?.rpc('agent/run', {
        message: text,
        files,
        images: images?.map(stripImagePreviewData),
        skillName,
        client: 'desktop',
        responseStyle: 'desktop-readable',
      })
    })().catch((err) => {
      console.error('agent/run RPC failed:', err)
      // Attribute the error to the session that owned the failed run, so the
      // sidebar entry for that session shows the error state — not whichever
      // session the user happens to be viewing now.
      const failedSessionId = get().activeRunSessionId ?? runSessionId ?? null
      get().handleAgentError({ sessionId: failedSessionId, message: String(err) })
    })
  },

  cancelRun() {
    const state = get()
    if (!state.isAgentRunning) return

    // Finalize whatever text we have so far as an agent message.
    const finalText = state.streamingText ?? ''
    const messages = [...state.messages]

    if (finalText.length > 0) {
      messages.push({
        id: makeId('agent', state.nextId),
        role: 'agent',
        text: finalText,
        timestamp: new Date().toISOString(),
        toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
        subagentRuns:
          state.pendingSubagentRuns.length > 0 ? [...state.pendingSubagentRuns] : undefined,
      })
    }

    set({
      messages,
      isAgentRunning: false,
      activeRunSessionId: null,
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      pendingSubagentRuns: [],
      pendingActivatedSkills: [],
      nextId: state.nextId + 1,
      contextUsage: null,
      sessions: state.activeRunSessionId
        ? state.sessions.map((s) =>
            s.id === state.activeRunSessionId
              ? { ...s, runStatus: 'idle' as const, activeToolName: undefined }
              : s,
          )
        : state.sessions,
    })

    window.ouroboros?.rpc('agent/cancel', {}).catch((err) => {
      console.error('agent/cancel RPC failed:', err)
    })
  },

  steerCurrentRun(text: string, images?: ImageAttachment[]) {
    const state = get()
    if (!state.isAgentRunning) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const id = makeId('steer', state.nextId)
    const sentAt = new Date().toISOString()
    const steerMessage: Message = {
      id,
      role: 'user',
      text: trimmed,
      timestamp: sentAt,
      imageAttachments: images,
      kind: 'steer',
      steerStatus: 'pending',
      steerRequestId: requestId,
    }

    const sessionId = state.activeRunSessionId

    set({
      messages: [...state.messages, steerMessage],
      nextId: state.nextId + 1,
    })

    void (async () => {
      const api = window.ouroboros
      if (!api) return
      try {
        const result = (await api.rpc('agent/steer', {
          message: trimmed,
          requestId,
          ...(sessionId ? { sessionId } : {}),
          images: images?.map(stripImagePreviewData),
        })) as { accepted: boolean; reason?: string; duplicate?: boolean }
        if (!result?.accepted) {
          // The CLI rejected the steer (no active run). Mark the bubble as
          // orphaned so the user can resend it as a normal message.
          set((s) => ({
            messages: s.messages.map((m) =>
              m.steerRequestId === requestId ? { ...m, steerStatus: 'orphaned' as const } : m,
            ),
          }))
        }
      } catch (err) {
        console.error('agent/steer RPC failed:', err)
        set((s) => ({
          messages: s.messages.map((m) =>
            m.steerRequestId === requestId ? { ...m, steerStatus: 'orphaned' as const } : m,
          ),
        }))
      }
    })()
  },

  resendOrphanedSteer(steerRequestId: string) {
    const state = get()
    const orphan = state.messages.find(
      (m) => m.steerRequestId === steerRequestId && m.steerStatus === 'orphaned',
    )
    if (!orphan) return
    set((s) => ({
      messages: s.messages.filter((m) => m.steerRequestId !== steerRequestId),
    }))
    get().sendMessage(orphan.text, orphan.files, orphan.imageAttachments)
  },

  dismissOrphanedSteer(steerRequestId: string) {
    set((s) => ({
      messages: s.messages.filter((m) => m.steerRequestId !== steerRequestId),
    }))
  },

  handleSteerInjected(params: AgentSteerInjectedNotification) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    const updateMessages = (messages: Message[]): Message[] =>
      messages.map((m) =>
        m.steerRequestId === params.steerId && m.steerStatus !== 'orphaned'
          ? { ...m, steerStatus: 'injected' as const }
          : m,
      )

    if (!runSessionId) {
      set({ messages: updateMessages(state.messages) })
      return
    }
    set(
      updateRunState(state, runSessionId, (snap) => ({
        ...snap,
        messages: updateMessages(snap.messages),
      })),
    )
  },

  handleSteerOrphaned(params: AgentSteerOrphanedNotification) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    const orphanIds = new Set(params.steers.map((s) => s.id))
    if (orphanIds.size === 0) return

    const updateMessages = (messages: Message[]): Message[] =>
      messages.map((m) =>
        m.steerRequestId && orphanIds.has(m.steerRequestId)
          ? { ...m, steerStatus: 'orphaned' as const }
          : m,
      )

    if (!runSessionId) {
      set({ messages: updateMessages(state.messages) })
      return
    }
    set(
      updateRunState(state, runSessionId, (snap) => ({
        ...snap,
        messages: updateMessages(snap.messages),
      })),
    )
  },

  handleTurnAborted(params: AgentTurnAbortedNotification) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    const sessions = runSessionId
      ? state.sessions.map((s) =>
          s.id === runSessionId
            ? { ...s, runStatus: 'idle' as const, activeToolName: undefined }
            : s,
        )
      : state.sessions

    if (!runSessionId) {
      set({
        sessions,
        isAgentRunning: false,
        activeRunSessionId: null,
        streamingText: null,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        pendingSubagentRuns: [],
      })
      return
    }

    // The aborted run owned `activeRunSessionId`; the flat run-state mirror
    // tracks that run regardless of which session is currently viewed, so
    // clear it eagerly here even if the user has switched away.
    const ownedActiveRun = state.activeRunSessionId === runSessionId
    set({
      sessions,
      ...updateRunState(state, runSessionId, (snap) => ({
        ...snap,
        isAgentRunning: false,
        streamingText: null,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        pendingSubagentRuns: [],
      })),
      ...(ownedActiveRun
        ? {
            activeRunSessionId: null,
            isAgentRunning: false,
            streamingText: null,
            activeToolCalls: new Map(),
            pendingToolCalls: [],
            pendingSubagentRuns: [],
          }
        : {}),
    })
  },

  handleAgentText(params: AgentTextParams) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    if (!runSessionId) {
      // No session attribution — apply to flat state directly. This keeps
      // legacy single-session callers (and tests that exercise notifications
      // before any session exists) working.
      set((s) => ({ streamingText: (s.streamingText ?? '') + normalizeTextContent(params.text) }))
      return
    }
    set(
      updateRunState(state, runSessionId, (snap) => ({
        ...snap,
        streamingText: (snap.streamingText ?? '') + normalizeTextContent(params.text),
      })),
    )
  },

  handleContextUsage(params: AgentContextUsageParams) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    if (!runSessionId) {
      set({ contextUsage: params })
      return
    }
    set(updateRunState(state, runSessionId, (snap) => ({ ...snap, contextUsage: params })))
  },

  handleToolCallStart(params: AgentToolCallStartParams) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    const toolName = normalizeToolName(params.toolName)

    // Sidebar entry's runStatus / activeToolName always update — the sidebar
    // shows status across all sessions.
    const sessions = runSessionId
      ? state.sessions.map((s) =>
          s.id === runSessionId
            ? { ...s, runStatus: 'running' as const, activeToolName: toolName }
            : s,
        )
      : state.sessions

    if (!runSessionId) {
      set({ sessions })
      return
    }

    set({
      sessions,
      ...updateRunState(state, runSessionId, (snap) => {
        const next = new Map(snap.activeToolCalls)
        next.set(params.toolCallId, {
          id: params.toolCallId,
          toolName,
          input: params.input,
          status: 'running',
        })
        return { ...snap, activeToolCalls: next }
      }),
    })
  },

  handleToolCallEnd(params: AgentToolCallEndParams) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    const sessions = runSessionId
      ? state.sessions.map((s) =>
          s.id === runSessionId ? { ...s, activeToolName: undefined } : s,
        )
      : state.sessions

    if (!runSessionId) {
      set({ sessions })
      return
    }

    set({
      sessions,
      ...updateRunState(state, runSessionId, (snap) => {
        const nextActive = new Map(snap.activeToolCalls)
        const existing = nextActive.get(params.toolCallId)
        if (existing) nextActive.delete(params.toolCallId)
        const completed: CompletedToolCall = {
          id: params.toolCallId,
          toolName: normalizeToolName(params.toolName ?? existing?.toolName),
          input: existing?.input,
          output: params.result,
          error: params.isError ? normalizeTextContent(params.result) : undefined,
        }
        return {
          ...snap,
          activeToolCalls: nextActive,
          pendingToolCalls: [...snap.pendingToolCalls, completed],
        }
      }),
    })
  },

  handleTurnComplete(params: AgentTurnCompleteParams) {
    const state = get()
    const completedSessionId = resolveRunSessionId(params, state)
    if (!completedSessionId) {
      // Synthetic turn-complete with no session attribution — happens for
      // the onboarding welcome message and for tests that exercise the
      // notification path before any session exists. Roll any pending
      // tool-calls / subagent runs / activated skills into the assistant
      // message so they appear in the rendered turn.
      set((s) => {
        const agentMessage: Message = {
          id: makeId('agent', s.nextId),
          role: 'agent',
          text: normalizeTextContent(params.text),
          timestamp: new Date().toISOString(),
          toolCalls: s.pendingToolCalls.length > 0 ? [...s.pendingToolCalls] : undefined,
          subagentRuns:
            s.pendingSubagentRuns.length > 0 ? [...s.pendingSubagentRuns] : undefined,
          activatedSkills:
            s.pendingActivatedSkills.length > 0 ? [...s.pendingActivatedSkills] : undefined,
        }
        return {
          messages: [...s.messages, agentMessage],
          streamingText: null,
          isAgentRunning: false,
          activeRunSessionId: null,
          activeToolCalls: new Map(),
          pendingToolCalls: [],
          pendingSubagentRuns: [],
          pendingActivatedSkills: [],
          nextId: s.nextId + 1,
        }
      })
      return
    }

    // Build the assistant message + finalize the snapshot whether the user is
    // currently viewing this session or not. The non-current case is what
    // makes "switching to a session whose run completed in the background"
    // show the final assistant message instead of stale streaming state.
    const updates = updateRunState(state, completedSessionId, (snap) => {
      const agentMessage: Message = {
        id: makeId('agent', snap.nextId),
        role: 'agent',
        text: normalizeTextContent(params.text),
        timestamp: new Date().toISOString(),
        toolCalls: snap.pendingToolCalls.length > 0 ? [...snap.pendingToolCalls] : undefined,
        subagentRuns:
          snap.pendingSubagentRuns.length > 0 ? [...snap.pendingSubagentRuns] : undefined,
        activatedSkills:
          snap.pendingActivatedSkills.length > 0 ? [...snap.pendingActivatedSkills] : undefined,
      }
      return {
        ...snap,
        messages: [...snap.messages, agentMessage],
        streamingText: null,
        isAgentRunning: false,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        pendingSubagentRuns: [],
        pendingActivatedSkills: [],
        nextId: snap.nextId + 1,
      }
    })

    // Refresh the sidebar entry's title/messageCount/runStatus for the
    // completed session — works whether or not it was the viewed session.
    const completedSnap = (updates.sessionRunSnapshots as Map<string, SessionRunSnapshot>).get(
      completedSessionId,
    )
    const messageCount = completedSnap?.messages.length ?? 0
    const lastAgentMessage = completedSnap?.messages[completedSnap.messages.length - 1]
    const sessions = state.sessions.map((s) => {
      if (s.id !== completedSessionId) return s
      let title = s.title
      if (s.titleSource !== 'manual') {
        const firstUserMsg = completedSnap?.messages.find((m) => m.role === 'user')
        if (firstUserMsg) {
          title = deriveCompletedSessionTitle(firstUserMsg.text, lastAgentMessage?.text)
        }
      }
      return {
        ...s,
        title,
        titleSource: s.titleSource === 'manual' ? ('manual' as const) : ('auto' as const),
        messageCount,
        lastActive: new Date().toISOString(),
        runStatus: 'idle' as const,
        activeToolName: undefined,
      }
    })

    set({
      ...updates,
      sessions,
      // Only clear the global run-tracker if it pointed at the completing
      // session. Another session may have started a run after this one.
      ...(state.activeRunSessionId === completedSessionId
        ? { activeRunSessionId: null }
        : {}),
    })
  },

  handleSkillActivated(params: { name: string; sessionId?: string | null }) {
    const state = get()
    const runSessionId = resolveRunSessionId(params, state)
    if (!runSessionId) {
      // No session attribution — fall back to flat state so the legacy
      // single-session test path keeps working.
      set((s) =>
        s.pendingActivatedSkills.includes(params.name)
          ? {}
          : { pendingActivatedSkills: [...s.pendingActivatedSkills, params.name] },
      )
      return
    }
    set(
      updateRunState(state, runSessionId, (snap) => {
        if (snap.pendingActivatedSkills.includes(params.name)) return snap
        return { ...snap, pendingActivatedSkills: [...snap.pendingActivatedSkills, params.name] }
      }),
    )
  },

  handleAgentError(params: AgentErrorParams) {
    const state = get()
    const failedSessionId = resolveRunSessionId(params, state)
    if (!failedSessionId) {
      // Synthetic error with no session attribution.
      set((s) => {
        const errorMessage: Message = {
          id: makeId('error', s.nextId),
          role: 'error',
          text: normalizeTextContent(params.message),
          timestamp: new Date().toISOString(),
        }
        return {
          messages: [...s.messages, errorMessage],
          streamingText: null,
          isAgentRunning: false,
          activeRunSessionId: null,
          activeToolCalls: new Map(),
          pendingToolCalls: [],
          pendingSubagentRuns: [],
          pendingActivatedSkills: [],
          nextId: s.nextId + 1,
          contextUsage: null,
        }
      })
      return
    }

    const updates = updateRunState(state, failedSessionId, (snap) => {
      // Finalize any in-progress streaming text as a partial agent message
      // so the user sees what made it through before the error landed.
      const messages = [...snap.messages]
      let nextId = snap.nextId
      if (snap.streamingText && snap.streamingText.length > 0) {
        messages.push({
          id: makeId('agent', nextId),
          role: 'agent',
          text: snap.streamingText,
          timestamp: new Date().toISOString(),
          toolCalls: snap.pendingToolCalls.length > 0 ? [...snap.pendingToolCalls] : undefined,
          subagentRuns:
            snap.pendingSubagentRuns.length > 0 ? [...snap.pendingSubagentRuns] : undefined,
        })
        nextId += 1
      }
      messages.push({
        id: makeId('error', nextId),
        role: 'error',
        text: normalizeTextContent(params.message),
        timestamp: new Date().toISOString(),
      })
      return {
        ...snap,
        messages,
        streamingText: null,
        isAgentRunning: false,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        pendingSubagentRuns: [],
        pendingActivatedSkills: [],
        nextId: nextId + 1,
        contextUsage: null,
      }
    })

    set({
      ...updates,
      sessions: state.sessions.map((s) =>
        s.id === failedSessionId
          ? { ...s, runStatus: 'error' as const, activeToolName: undefined }
          : s,
      ),
      ...(state.activeRunSessionId === failedSessionId
        ? { activeRunSessionId: null }
        : {}),
    })
  },

  handleSubagentStarted(params: AgentSubagentStartedNotification) {
    const state = get()
    const sessionId = resolveSubagentSessionId(params, state)
    if (!sessionId) return
    set(
      updateRunState(state, sessionId, (snap) => ({
        ...snap,
        pendingSubagentRuns: upsertSubagentRun(snap.pendingSubagentRuns, createSubagentRun(params)),
      })),
    )
  },

  handleSubagentUpdated(params: AgentSubagentUpdatedNotification) {
    const state = get()
    const sessionId = resolveSubagentSessionId(params, state)
    if (!sessionId) return
    const updater = (run: SubagentRun): SubagentRun => ({
      ...run,
      childSessionId: params.childSessionId ?? run.childSessionId,
      task: params.task,
      status: 'running',
      updatedAt: params.updatedAt,
      message: params.message,
    })
    set(
      updateRunState(state, sessionId, (snap) =>
        applySubagentUpdate(snap, params.runId, updater, params),
      ),
    )
  },

  handleSubagentCompleted(params: AgentSubagentCompletedNotification) {
    const state = get()
    const sessionId = resolveSubagentSessionId(params, state)
    if (!sessionId) return
    const result = extractSubagentResult(params.result)
    const workerDiff = extractWorkerDiff(params.result, params.workerDiff)
    const updater = (run: SubagentRun): SubagentRun => ({
      ...run,
      childSessionId: params.childSessionId ?? run.childSessionId,
      task: params.task,
      status: 'completed',
      completedAt: params.completedAt,
      summary: result.summary,
      evidenceCount: result.evidenceCount,
      uncertaintyCount: result.uncertaintyCount,
      evidence: result.evidence,
      workerDiff: workerDiff ?? run.workerDiff,
      failureMessage: undefined,
    })
    set(
      updateRunState(state, sessionId, (snap) =>
        applySubagentUpdate(snap, params.runId, updater, params),
      ),
    )
  },

  handleSubagentFailed(params: AgentSubagentFailedNotification) {
    const state = get()
    const sessionId = resolveSubagentSessionId(params, state)
    if (!sessionId) return
    const result = extractSubagentResult(params.result)
    const workerDiff = extractWorkerDiff(params.result, params.workerDiff)
    const updater = (run: SubagentRun): SubagentRun => ({
      ...run,
      childSessionId: params.childSessionId ?? run.childSessionId,
      task: params.task,
      status: 'failed',
      completedAt: params.completedAt,
      summary: result.summary,
      evidenceCount: result.evidenceCount,
      uncertaintyCount: result.uncertaintyCount,
      evidence: result.evidence,
      workerDiff: workerDiff ?? run.workerDiff,
      failureMessage: params.error.message,
    })
    set(
      updateRunState(state, sessionId, (snap) =>
        applySubagentUpdate(snap, params.runId, updater, params),
      ),
    )
  },

  handlePermissionLeaseUpdated(params: AgentPermissionLeaseUpdatedNotification) {
    // Permission lease updates don't carry a `sessionId` — they relate to a
    // subagent run identified only by `agentRunId`. Apply across every
    // session's snapshot (and the flat current state) so the update lands
    // wherever that run is tracked, regardless of which view is active.
    const updater = (run: SubagentRun): SubagentRun => ({
      ...run,
      permissionLeases: upsertPermissionLease(run.permissionLeases, params),
    })
    set((state) => applyAcrossAllSessions(state, params.agentRunId, updater))
  },

  handleWorkerDiffUpdated(params: WorkerDiffDisplayDetails) {
    // Same cross-session apply as permission leases — the worker diff update
    // matches by `taskId` via isSameWorkerDiff so we can't pre-filter by
    // session.
    const updater = (run: SubagentRun): SubagentRun =>
      isSameWorkerDiff(run.workerDiff, params)
        ? { ...run, workerDiff: { ...run.workerDiff, ...params } }
        : run
    set((state) => applyAcrossAllSessions(state, undefined, updater))
  },

  resetConversation() {
    set({
      ...flatFromSnapshot(emptySnapshot()),
      activeRunSessionId: null,
      currentSessionId: null,
      sessionRunSnapshots: new Map(),
    })
  },

  setSessions(sessions: SessionInfo[]) {
    set((state) => ({
      sessions: sessions
        .map((session) => {
          const existing = state.sessions.find((s) => s.id === session.id)
          const isRunningSession =
            existing?.runStatus === 'running' ||
            (!existing && state.activeRunSessionId === session.id) ||
            (existing && state.activeRunSessionId === session.id)
          if (isRunningSession) {
            return {
              ...session,
              runStatus: 'running' as const,
              activeToolName: existing?.activeToolName,
              // Preserve the desktop's derived title — the CLI's title is only
              // refreshed after the run completes (refreshAutoSessionTitle in
              // agent/run handler), so during processing the desktop's locally
              // derived title from sendMessage is more accurate.
              title: existing?.title ?? session.title,
              titleSource: existing?.titleSource ?? session.titleSource,
            }
          }
          if (existing?.runStatus === 'error') {
            return { ...session, runStatus: 'error' as const }
          }
          return session
        })
        .concat(
          state.sessions.filter(
            (session) =>
              !sessions.some((incoming) => incoming.id === session.id) &&
              (session.id === state.currentSessionId || session.id === state.activeRunSessionId),
          ),
        ),
    }))
  },

  setCurrentSessionId(id: string | null) {
    const state = get()
    if (state.currentSessionId === id) return
    // Snapshot the outgoing session's flat state so its in-flight messages,
    // streamingText, etc. survive a switch-back.
    const snapshots = new Map(state.sessionRunSnapshots)
    if (state.currentSessionId) {
      snapshots.set(state.currentSessionId, snapshotFromFlat(state))
    }
    // Restore incoming session's snapshot (or start fresh if we've never
    // seen it). The flat fields mirror the snapshot so component code that
    // reads `state.messages` etc. keeps working unchanged.
    const incoming = id ? (snapshots.get(id) ?? emptySnapshot()) : emptySnapshot()
    set({
      currentSessionId: id,
      sessionRunSnapshots: snapshots,
      ...flatFromSnapshot(incoming),
    })
  },

  loadSession(
    id: string,
    sessionMessages: SessionMessage[],
    workspacePath?: string | null,
  ) {
    const state = get()
    const messages: Message[] = sessionMessages.map((m, i) => ({
      id: makeId(m.role === 'user' ? 'user' : 'agent', i + 1),
      role: m.role === 'user' ? ('user' as const) : ('agent' as const),
      text: normalizeTextContent(m.content),
      timestamp: m.timestamp,
      imageAttachments: m.imageAttachments,
      ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
        ? { toolCalls: m.toolCalls }
        : {}),
      ...(m.role === 'assistant' && m.activatedSkills && m.activatedSkills.length > 0
        ? { activatedSkills: m.activatedSkills }
        : {}),
    }))

    // Snapshot the outgoing session before switching so its in-flight state
    // is preserved if the user comes back.
    const snapshots = new Map(state.sessionRunSnapshots)
    if (state.currentSessionId && state.currentSessionId !== id) {
      snapshots.set(state.currentSessionId, snapshotFromFlat(state))
    }

    // Choose the incoming snapshot. If we already have one (from a prior
    // visit or background notifications), prefer it when it has at least as
    // many messages as the CLI's persisted copy — its accumulated streaming
    // / pending state is more recent. Otherwise build fresh from the CLI
    // payload so cold loads work.
    const existing = snapshots.get(id)
    // When the CLI's persisted message list is longer than the local snapshot,
    // a run for this session has completed and persisted in the background —
    // any streamed/pending state from the existing snapshot is stale and must
    // be dropped, otherwise the streaming row keeps rendering after the
    // completed assistant message has already been finalized.
    const cliRunCompleted = !!existing && messages.length > existing.messages.length
    const incoming: SessionRunSnapshot =
      existing && existing.messages.length >= messages.length
        ? existing
        : {
            messages,
            streamingText: cliRunCompleted ? null : (existing?.streamingText ?? null),
            activeToolCalls: cliRunCompleted
              ? new Map()
              : (existing?.activeToolCalls ?? new Map()),
            pendingToolCalls: cliRunCompleted ? [] : (existing?.pendingToolCalls ?? []),
            pendingSubagentRuns: cliRunCompleted ? [] : (existing?.pendingSubagentRuns ?? []),
            pendingActivatedSkills: cliRunCompleted
              ? []
              : (existing?.pendingActivatedSkills ?? []),
            isAgentRunning: cliRunCompleted ? false : state.activeRunSessionId === id,
            contextUsage: existing?.contextUsage ?? null,
            nextId: messages.length + 1,
          }
    snapshots.set(id, incoming)

    set({
      currentSessionId: id,
      sessionRunSnapshots: snapshots,
      ...flatFromSnapshot(incoming),
      workspace: workspacePath ?? null,
    })

    hydrateLoadedImagePreviews(id, incoming.messages, set, get)
  },

  createNewSession(
    sessionId: string,
    workspacePath?: string | null,
    workspaceMode?: WorkspaceMode,
  ) {
    const state = get()
    const newSession: SessionInfo = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      messageCount: 0,
      title: 'New conversation',
      titleSource: 'auto',
      workspacePath,
      workspaceMode,
    }

    // Snapshot the outgoing session before switching to the new one — this
    // is what preserves the previous session's chat history when the user
    // clicks "+ new chat" while a turn is still streaming.
    const snapshots = new Map(state.sessionRunSnapshots)
    if (state.currentSessionId) {
      snapshots.set(state.currentSessionId, snapshotFromFlat(state))
    }
    snapshots.set(sessionId, emptySnapshot())

    set({
      ...flatFromSnapshot(emptySnapshot()),
      // Preserve the global activeRunSessionId — another session's run may
      // still be in flight, and we don't want to lose the tracker just
      // because the user clicked "+ new chat".
      activeRunSessionId: state.activeRunSessionId,
      currentSessionId: sessionId,
      workspace: workspacePath ?? null,
      sessions: [newSession, ...state.sessions],
      sessionRunSnapshots: snapshots,
    })
  },

  deleteSession(id: string) {
    const state = get()
    const newSessions = state.sessions.filter((s) => s.id !== id)
    // Drop the deleted session's snapshot so it doesn't leak memory and so
    // recreating a session with the same id (unlikely but possible) starts
    // empty.
    const snapshots = new Map(state.sessionRunSnapshots)
    snapshots.delete(id)

    const updates: Partial<ConversationState> = {
      sessions: newSessions,
      sessionRunSnapshots: snapshots,
    }

    if (state.activeRunSessionId === id) {
      updates.activeRunSessionId = null
    }

    // If we're deleting the currently-viewed session, clear the visible chat.
    if (state.currentSessionId === id) {
      Object.assign(updates, flatFromSnapshot(emptySnapshot()), { currentSessionId: null })
    }

    set(updates as ConversationState)
  },

  renameSession(id: string, title: string) {
    const cleanedTitle = finalizeSessionTitle(title.trim().replace(/\s+/g, ' '))
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title: cleanedTitle, titleSource: 'manual' as const } : s,
      ),
    }))
  },

  setWorkspace(path: string | null) {
    set({ workspace: path })
  },

  setWorkspaceMode(mode: WorkspaceMode) {
    set({
      workspaceMode: mode,
      workspaceModeError:
        mode === 'workspace' && !get().selectedWorkspacePath
          ? 'Select a workspace folder before starting a Workspace chat.'
          : null,
    })
  },

  setSelectedWorkspacePath(path: string | null) {
    set({
      selectedWorkspacePath: path,
      workspace: path,
      workspaceModeError: path ? null : get().workspaceModeError,
    })
  },

  clearWorkspaceModeError() {
    set({ workspaceModeError: null })
  },

  setModelName(name: string | null) {
    set({ modelName: name })
  },

  setReasoningEffort(effort: 'minimal' | 'low' | 'medium' | 'high' | 'max' | null) {
    set({ reasoningEffort: effort })
  },
}))
