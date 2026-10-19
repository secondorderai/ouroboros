import type { ModelMessage } from 'ai'

/**
 * LLM types decoupled from Vercel AI SDK internals.
 * The rest of the codebase should import from here, not from 'ai' directly.
 */

/**
 * A message in the LLM conversation.
 * Mirrors CoreMessage from Vercel AI SDK but keeps the codebase decoupled.
 */
export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: LLMUserContent }
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      providerState?: AssistantResponseState
    }
  | { role: 'tool'; content: ToolResult[] }

/** Opaque response state, replayable only to its originating provider/model. */
export interface AssistantResponseState {
  provider: string
  modelId: string
  message: Extract<ModelMessage, { role: 'assistant' }>
}

export type LLMUserContent = string | LLMUserContentPart[]

export type LLMUserContentPart = LLMTextPart | LLMFilePart

export interface LLMTextPart {
  type: 'text'
  text: string
}

export interface LLMFilePart {
  type: 'file'
  data: Uint8Array
  mediaType: string
  filename?: string
  path?: string
  sizeBytes?: number
}

export interface ImageAttachment {
  path: string
  name: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  sizeBytes: number
}

export function llmUserContentToText(content: LLMUserContent): string {
  if (typeof content === 'string') return content

  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      return `[Image: ${part.filename ?? part.mediaType}]`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * A tool call returned by the LLM.
 */
export interface ToolCall {
  /** Unique ID for this tool call, used to match with tool results */
  toolCallId: string
  /** Name of the tool to invoke */
  toolName: string
  /** Parsed input for the tool */
  input: Record<string, unknown>
}

/**
 * A tool result to send back to the LLM.
 */
export interface ToolResult {
  /** ID of the tool call this result corresponds to */
  toolCallId: string
  /** Name of the tool that produced this result */
  toolName: string
  /** The result value */
  result: unknown
}

/**
 * A chunk from a streaming LLM response.
 */
export type StreamChunk =
  | { type: 'assistant-state'; state: AssistantResponseState }
  | { type: 'text-delta'; textDelta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool-call-streaming-start'; toolCallId: string; toolName: string }
  | { type: 'tool-call-delta'; toolCallId: string; toolName: string; inputTextDelta: string }
  | { type: 'finish'; finishReason: FinishReason; usage: TokenUsage }
  | { type: 'error'; error: Error }

/**
 * Why the LLM stopped generating.
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown'

/**
 * Token usage information from a response.
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * The complete result from a non-streaming LLM call.
 */
export interface GenerateResult {
  assistantState?: AssistantResponseState
  /** The generated text */
  text: string
  /** Any tool calls made by the model */
  toolCalls: ToolCall[]
  /** Why the model stopped generating */
  finishReason: FinishReason
  /** Token usage information */
  usage: TokenUsage
}

/**
 * A streaming response that can be iterated over.
 */
export interface StreamResponse {
  /** Async iterable of stream chunks */
  stream: AsyncIterable<StreamChunk>
}

/**
 * Unified reasoning effort levels across providers.
 *
 * Supported choices are determined by the shared model catalogue and account.
 */
export type { ReasoningEffort } from '@ouroboros/shared'
import type { ReasoningEffort } from '@ouroboros/shared'

/**
 * Options for LLM calls (both streaming and non-streaming).
 */
export interface LLMCallOptions {
  /** System prompt */
  system?: string
  /** Temperature for sampling (0-2) */
  temperature?: number
  /** Maximum tokens to generate */
  maxTokens?: number
  /** Stop sequences */
  stopSequences?: string[]
  /** Tool definitions available to the model */
  tools?: Record<string, LLMToolSpec>
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /**
   * Reasoning effort for capable models. Maps to Anthropic adaptive thinking
   * (`thinking.type: 'adaptive'` + `effort`) on current Claude models,
   * or to the model's `reasoningEffort` option. Silently
   * ignored on models that don't support reasoning. Values outside a provider's
   * accepted set are clamped to the closest level.
   */
  reasoningEffort?: ReasoningEffort
}

/**
 * A tool definition that the LLM can call.
 */
export interface LLMToolSpec {
  /** Human-readable description of what the tool does */
  description: string
  /** JSON Schema for the tool's parameters */
  parameters: Record<string, unknown>
}
