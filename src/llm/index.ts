/**
 * LLM module — provider-agnostic language model abstraction.
 *
 * Usage:
 *   import { createProvider, streamResponse, generateResponse, buildSystemPrompt } from '@src/llm'
 *   import type { LLMMessage, StreamChunk, ToolCall, BuildSystemPromptOptions, SkillEntry } from '@src/llm'
 */

export { createProvider, type ModelConfig } from './provider'
export { streamResponse, generateResponse } from './streaming'
export { buildSystemPrompt, type BuildSystemPromptOptions, type SkillEntry } from './prompt'
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
