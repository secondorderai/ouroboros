/**
 * Streaming Response Handler
 *
 * Thin wrappers around Vercel AI SDK's streamText and generateText.
 * All errors are caught and returned as Result errors, never thrown.
 */

import {
  streamText,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { type Result, ok, err } from '@src/types'
import { OPENAI_CHATGPT_PROVIDER } from '@src/auth/openai-chatgpt'
import { buildReasoningProviderOptions } from './reasoning'
import type {
  LLMMessage,
  LLMCallOptions,
  StreamResponse,
  StreamChunk,
  GenerateResult,
  LLMToolSpec,
  FinishReason,
} from './types'

/**
 * Convert our LLMMessage types to Vercel AI SDK ModelMessage types.
 */
export function toModelMsgs(messages: LLMMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'system') {
      return { role: 'system' as const, content: msg.content }
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user' as const, content: msg.content }
      }
      return {
        role: 'user' as const,
        content: msg.content.map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'file' as const,
                data: part.data,
                mediaType: part.mediaType,
                ...(part.filename ? { filename: part.filename } : {}),
              },
        ),
      }
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output:
            typeof r.result === 'string'
              ? { type: 'text' as const, value: r.result }
              : { type: 'json' as const, value: r.result as import('@ai-sdk/provider').JSONValue },
        })),
      }
    }
    // assistant message
    if ('toolCalls' in msg && msg.toolCalls) {
      return {
        role: 'assistant' as const,
        content: [
          ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
          ...msg.toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          })),
        ],
      }
    }
    return { role: 'assistant' as const, content: msg.content }
  })
}

/**
 * Convert our LLMToolSpec map to Vercel AI SDK ToolSet format.
 */
function toToolSet(tools?: Record<string, LLMToolSpec>): ToolSet | undefined {
  if (!tools || Object.keys(tools).length === 0) return undefined

  const toolSet: ToolSet = {}
  for (const [name, def] of Object.entries(tools)) {
    toolSet[name] = {
      description: def.description,
      inputSchema: jsonSchema(def.parameters),
    } as ToolSet[string]
  }
  return toolSet
}

interface PreparedPromptOptions {
  system?: string
  providerOptions?: Record<string, JSONObject>
  /** When set, callers must use this temperature in place of `options.temperature`. */
  effectiveTemperature?: number
}

function getProviderPromptOptions(
  model: LanguageModel,
  options?: LLMCallOptions,
): PreparedPromptOptions {
  const provider = (model as { provider?: unknown }).provider
  const isChatgptResponses = provider === `${OPENAI_CHATGPT_PROVIDER}.responses`

  const reasoning = buildReasoningProviderOptions(
    model,
    options?.thinkingBudgetTokens,
    options?.reasoningEffort,
    options?.maxTokens,
  )

  const providerOptions: Record<string, JSONObject> = {}

  if (isChatgptResponses) {
    providerOptions.openai = {
      store: false,
      ...(options?.system ? { instructions: options.system } : {}),
    }
  }

  if (reasoning.providerOptions) {
    for (const [key, value] of Object.entries(reasoning.providerOptions)) {
      providerOptions[key] = { ...(providerOptions[key] ?? {}), ...value }
    }
  }

  const result: PreparedPromptOptions = {}

  if (!isChatgptResponses && options?.system) {
    result.system = options.system
  }

  if (Object.keys(providerOptions).length > 0) {
    result.providerOptions = providerOptions
  }

  if (reasoning.forceTemperatureOne) {
    result.effectiveTemperature = 1
  }

  return result
}

/**
 * Classify an error into an actionable message.
 */
function classifyError(error: unknown): Error {
  const details = extractErrorDetails(error)

  if (details) {
    const msg = details.message.toLowerCase()
    const name = details.name.toLowerCase()
    const code = details.code?.toLowerCase() ?? ''

    // Authentication errors
    if (
      msg.includes('api key') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('authentication') ||
      msg.includes('sign in') ||
      name.includes('authenticationerror')
    ) {
      return new Error(
        `Authentication failed: ${details.message}. Check that your API key is valid and has not expired.`,
      )
    }

    // Rate limiting / quota errors
    if (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('quota') ||
      code.includes('insufficient_quota')
    ) {
      return new Error(
        `Rate limited or quota exceeded: ${details.message}. Check billing/quota, wait a moment, or reduce request frequency.`,
      )
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
        `Network error: ${details.message}. Check your internet connection and that the API endpoint is reachable.`,
      )
    }

    return new Error(details.message)
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    const name = error.name.toLowerCase()

    // Authentication errors
    if (
      msg.includes('api key') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('authentication') ||
      msg.includes('sign in') ||
      name.includes('authenticationerror')
    ) {
      return new Error(
        `Authentication failed: ${error.message}. Check that your API key is valid and has not expired.`,
      )
    }

    // Rate limiting
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
      return new Error(
        `Rate limited: ${error.message}. Wait a moment and try again, or reduce request frequency.`,
      )
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
        `Network error: ${error.message}. Check your internet connection and that the API endpoint is reachable.`,
      )
    }

    return error
  }

  return new Error(String(error))
}

function extractErrorDetails(
  error: unknown,
): { message: string; name: string; code?: string } | null {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown }
    return {
      message: error.message,
      name: error.name,
      code: typeof errorWithCode.code === 'string' ? errorWithCode.code : undefined,
    }
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const nested =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : undefined

    const message =
      pickString(record.message) ??
      pickString(record.value) ??
      pickString(nested?.message) ??
      pickString(nested?.value)

    const code = pickString(record.code) ?? pickString(nested?.code)
    const name =
      pickString(record.name) ?? pickString(record.type) ?? pickString(nested?.type) ?? 'Error'

    if (message) {
      return { message, name, code: code ?? undefined }
    }

    try {
      return {
        message: JSON.stringify(error, null, 2),
        name: name || 'Error',
        code: code ?? undefined,
      }
    } catch {
      return { message: String(error), name: name || 'Error', code: code ?? undefined }
    }
  }

  return null
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
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
  model: LanguageModel,
  messages: LLMMessage[],
  options?: LLMCallOptions,
): Result<StreamResponse> {
  try {
    const modelMessages = toModelMsgs(messages)
    const tools = toToolSet(options?.tools)
    const { effectiveTemperature, ...promptOptions } = getProviderPromptOptions(model, options)

    const result = streamText({
      model,
      ...promptOptions,
      messages: modelMessages,
      temperature: effectiveTemperature ?? options?.temperature,
      maxOutputTokens: options?.maxTokens,
      stopSequences: options?.stopSequences,
      tools,
      abortSignal: options?.abortSignal,
    })

    // fullStream is typed as AsyncIterable<TextStreamPart<TOOLS>> but we use `any`
    // in createChunkStream to avoid coupling to the AI SDK's complex generic types
    const stream = createChunkStream(result.fullStream as AsyncIterable<unknown>)

    return ok({ stream })
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
  fullStream: AsyncIterable<any>,
): AsyncIterable<StreamChunk> {
  try {
    for await (const part of fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text-delta', textDelta: part.text as string }
          break

        case 'tool-call':
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            input: part.input as Record<string, unknown>,
          }
          break

        case 'tool-input-start':
          yield {
            type: 'tool-call-streaming-start',
            toolCallId: part.id as string,
            toolName: part.toolName as string,
          }
          break

        case 'tool-input-delta':
          yield {
            type: 'tool-call-delta',
            toolCallId: part.id as string,
            toolName: '',
            inputTextDelta: part.delta as string,
          }
          break

        case 'finish': {
          const usage = part.totalUsage ?? {}
          yield {
            type: 'finish',
            finishReason: (part.finishReason ?? 'unknown') as FinishReason,
            usage: {
              promptTokens: usage.inputTokens ?? 0,
              completionTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens ?? 0,
            },
          }
          break
        }

        case 'error':
          yield { type: 'error', error: classifyError(part.error) }
          break

        // Skip other event types (reasoning, source, start-step, finish-step, etc.)
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
  model: LanguageModel,
  messages: LLMMessage[],
  options?: LLMCallOptions,
): Promise<Result<GenerateResult>> {
  try {
    const modelMessages = toModelMsgs(messages)
    const tools = toToolSet(options?.tools)
    const { effectiveTemperature, ...promptOptions } = getProviderPromptOptions(model, options)

    const result = await generateText({
      model,
      ...promptOptions,
      messages: modelMessages,
      temperature: effectiveTemperature ?? options?.temperature,
      maxOutputTokens: options?.maxTokens,
      stopSequences: options?.stopSequences,
      tools,
      abortSignal: options?.abortSignal,
    })

    return ok({
      text: result.text,
      toolCalls: result.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input as Record<string, unknown>,
      })),
      finishReason: result.finishReason,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
    })
  } catch (error) {
    return err(classifyError(error))
  }
}
