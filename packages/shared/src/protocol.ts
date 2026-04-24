/**
 * JSON-RPC notification types for the Ouroboros protocol.
 *
 * These define the shape of notifications the CLI sends to the Desktop app.
 * They map directly to AgentEvent and RSIEvent types in the CLI.
 */

// ── Agent notifications ─────────────────────────────────────────────

export interface AgentTextNotification {
  method: 'agent/text'
  params: { text: string }
}

export interface AgentContextUsageNotification {
  method: 'agent/contextUsage'
  params: {
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
}

export interface AgentToolCallStartNotification {
  method: 'agent/toolCallStart'
  params: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }
}

export interface AgentToolCallEndNotification {
  method: 'agent/toolCallEnd'
  params: {
    toolCallId: string
    toolName: string
    result: unknown
    isError: boolean
  }
}

export interface AgentTurnCompleteNotification {
  method: 'agent/turnComplete'
  params: {
    text: string
    iterations: number
  }
}

export interface AgentErrorNotification {
  method: 'agent/error'
  params: {
    message: string
    recoverable: boolean
  }
}

// ── RSI notifications ───────────────────────────────────────────────

export interface RSIReflectionNotification {
  method: 'rsi/reflection'
  params: { reflection: unknown }
}

export interface RSICrystallizationNotification {
  method: 'rsi/crystallization'
  params: { result: unknown }
}

export interface RSIDreamNotification {
  method: 'rsi/dream'
  params: { result: unknown }
}

export interface RSIErrorNotification {
  method: 'rsi/error'
  params: { stage: string; message: string }
}

// ── Approval notifications ──────────────────────────────────────────

export interface ApprovalRequestNotification {
  method: 'approval/request'
  params: {
    id: string
    description: string
    risk: string
    diff?: string
  }
}

// ── Union type ──────────────────────────────────────────────────────

export type ProtocolNotification =
  | AgentTextNotification
  | AgentContextUsageNotification
  | AgentToolCallStartNotification
  | AgentToolCallEndNotification
  | AgentTurnCompleteNotification
  | AgentErrorNotification
  | RSIReflectionNotification
  | RSICrystallizationNotification
  | RSIDreamNotification
  | RSIErrorNotification
  | ApprovalRequestNotification
