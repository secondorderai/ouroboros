/**
 * LLM module — provider-agnostic language model abstraction.
 *
 * Usage:
 *   import { createProvider, streamResponse, generateResponse } from '@src/llm'
 *   import type { LLMMessage, StreamChunk, ToolCall } from '@src/llm'
 */

export { createProvider, type ModelConfig } from './provider'
export { streamResponse, generateResponse } from './streaming'
export type {
  LLMMessage,
  ToolCall,
  ToolResult,
  StreamChunk,
  StreamResponse,
  GenerateResult,
  FinishReason,
  TokenUsage,
  LLMCallOptions,
  ToolDefinition
} from './types'
