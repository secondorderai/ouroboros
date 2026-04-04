/**
 * Streaming Response Handler
 *
 * Thin wrappers around Vercel AI SDK's streamText and generateText.
 * All errors are caught and returned as Result errors, never thrown.
 */

import { streamText, generateText, type LanguageModelV1, type CoreMessage, type ToolSet } from 'ai'
import { type Result, ok, err } from '@src/types'
import type {
  LLMMessage,
  LLMCallOptions,
  StreamResponse,
  StreamChunk,
  GenerateResult,
  ToolCall,
  TokenUsage,
  ToolDefinition,
  FinishReason
} from './types'
import { jsonSchema } from 'ai'

/**
 * Convert our LLMMessage types to Vercel AI SDK CoreMessage types.
 */
function toCoreMsgs(messages: LLMMessage[]): CoreMessage[] {
  return messages.map(msg => {
    if (msg.role === 'system') {
      return { role: 'system' as const, content: msg.content }
    }
    if (msg.role === 'user') {
      return { role: 'user' as const, content: msg.content }
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content.map(r => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          result: r.result
        }))
      }
    }
    // assistant message
    if ('toolCalls' in msg && msg.toolCalls) {
      return {
        role: 'assistant' as const,
        content: [
          ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
          ...msg.toolCalls.map(tc => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args
          }))
        ]
      }
    }
    return { role: 'assistant' as const, content: msg.content }
  })
}

/**
 * Convert our ToolDefinition map to Vercel AI SDK ToolSet format.
 */
function toToolSet(tools?: Record<string, ToolDefinition>): ToolSet | undefined {
  if (!tools || Object.keys(tools).length === 0) return undefined

  const toolSet: ToolSet = {}
  for (const [name, def] of Object.entries(tools)) {
    toolSet[name] = {
      description: def.description,
      parameters: jsonSchema(def.parameters)
    }
  }
  return toolSet
}

/**
 * Classify an error into an actionable message.
 */
function classifyError(error: unknown): Error {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    const name = error.name.toLowerCase()

    // Authentication errors
    if (
      msg.includes('api key') ||
      msg.includes('unauthorized') ||
      msg.includes('401') ||
      msg.includes('authentication') ||
      name.includes('authenticationerror')
    ) {
      return new Error(`Authentication failed: ${error.message}. Check that your API key is valid and has not expired.`)
    }

    // Rate limiting
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
      return new Error(`Rate limited: ${error.message}. Wait a moment and try again, or reduce request frequency.`)
    }

    // Network errors
    if (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      name.includes('aborterror')
    ) {
      return new Error(
        `Network error: ${error.message}. Check your internet connection and that the API endpoint is reachable.`
      )
    }

    return error
  }

  return new Error(String(error))
}

/**
 * Stream a response from the LLM, yielding chunks incrementally.
 *
 * Returns a Result containing a StreamResponse with:
 * - stream: an async iterable of StreamChunk (text deltas, tool calls, finish events)
 * - text: a promise resolving to the full generated text
 * - toolCalls: a promise resolving to all tool calls
 * - usage: a promise resolving to token usage
 *
 * Errors during setup (e.g., invalid model) are returned as Result errors.
 * Errors during streaming are yielded as error chunks in the stream.
 */
export function streamResponse(
  model: LanguageModelV1,
  messages: LLMMessage[],
  options?: LLMCallOptions
): Result<StreamResponse> {
  try {
    const coreMessages = toCoreMsgs(messages)
    const tools = toToolSet(options?.tools)

    const result = streamText({
      model,
      messages: coreMessages,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      stopSequences: options?.stopSequences,
      tools,
      abortSignal: options?.abortSignal
    })

    // fullStream is typed as AsyncIterable<TextStreamPart<TOOLS>> but we use `any`
    // in createChunkStream to avoid coupling to the AI SDK's complex generic types
    const stream = createChunkStream(result.fullStream as AsyncIterable<unknown>)

    const text = result.text
    const toolCalls: Promise<ToolCall[]> = result.toolCalls.then(calls =>
      calls.map(tc => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args as Record<string, unknown>
      }))
    )
    const usage: Promise<TokenUsage> = result.usage.then(u => ({
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.totalTokens
    }))

    return ok({ stream, text, toolCalls, usage })
  } catch (error) {
    return err(classifyError(error))
  }
}

/**
 * Create an async iterable of StreamChunks from a Vercel AI SDK full stream.
 *
 * The AI SDK fullStream emits many event types (step-start, step-finish, reasoning, etc.).
 * We only forward the ones relevant to the agent loop: text deltas, tool calls, finish, and errors.
 *
 * Error handling:
 * - Errors thrown from doStream (e.g., auth failures) appear as 'error' type events in fullStream.
 * - Errors in the underlying ReadableStream (e.g., connection drops) are thrown during iteration.
 * Both are caught and yielded as error chunks.
 */
async function* createChunkStream(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fullStream: AsyncIterable<any>
): AsyncIterable<StreamChunk> {
  try {
    for await (const part of fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text-delta', textDelta: part.textDelta as string }
          break

        case 'tool-call':
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            args: part.args as Record<string, unknown>
          }
          break

        case 'tool-call-streaming-start':
          yield {
            type: 'tool-call-streaming-start',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string
          }
          break

        case 'tool-call-delta':
          yield {
            type: 'tool-call-delta',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            argsTextDelta: part.argsTextDelta as string
          }
          break

        case 'finish': {
          const usage = part.usage ?? {}
          yield {
            type: 'finish',
            finishReason: (part.finishReason ?? 'unknown') as FinishReason,
            usage: {
              promptTokens: usage.promptTokens ?? 0,
              completionTokens: usage.completionTokens ?? 0,
              totalTokens: usage.totalTokens ?? 0
            }
          }
          break
        }

        case 'error':
          yield { type: 'error', error: classifyError(part.error) }
          break

        // Skip other event types (reasoning, source, step-start, step-finish, etc.)
        default:
          break
      }
    }
  } catch (error) {
    yield { type: 'error', error: classifyError(error) }
  }
}

/**
 * Generate a complete (non-streaming) response from the LLM.
 *
 * @returns Result containing the full generation result or an error
 */
export async function generateResponse(
  model: LanguageModelV1,
  messages: LLMMessage[],
  options?: LLMCallOptions
): Promise<Result<GenerateResult>> {
  try {
    const coreMessages = toCoreMsgs(messages)
    const tools = toToolSet(options?.tools)

    const result = await generateText({
      model,
      messages: coreMessages,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      stopSequences: options?.stopSequences,
      tools,
      abortSignal: options?.abortSignal
    })

    return ok({
      text: result.text,
      toolCalls: result.toolCalls.map(tc => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args as Record<string, unknown>
      })),
      finishReason: result.finishReason,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens
      }
    })
  } catch (error) {
    return err(classifyError(error))
  }
}
