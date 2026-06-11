/**
 * Structured LLM calls — shared non-streaming JSON helper.
 *
 * `generateStructured()` makes a single non-streaming LLM call and parses the
 * response as JSON validated against a Zod schema. It ports the hardening
 * originally developed for RSI reflection (`rsi/crystallize.ts`):
 *
 *   - markdown fence extraction before `JSON.parse`
 *   - one retry without sampling options on retryable 400 responses (some
 *     OpenAI-compatible endpoints reject temperature/maxTokens with a 400)
 *   - the temperature option is withheld for OpenAI reasoning models, which
 *     reject explicit temperature values
 *
 * Convention: never throw — always return a `Result`.
 */
import type { LanguageModel } from 'ai'
import type { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import { generateResponse } from '@src/llm/streaming'
import { getReasoningSupport } from '@src/llm/model-capabilities'
import type { LLMCallOptions } from '@src/llm/types'

export interface GenerateStructuredOptions {
  /** Sampling temperature. Silently dropped for OpenAI reasoning models. */
  temperature?: number
  /** Maximum tokens to generate. */
  maxTokens?: number
  /** Abort signal for cancellation; preserved across the retryable-400 fallback. */
  abortSignal?: AbortSignal
}

function isOpenAIReasoningModel(model: LanguageModel): boolean {
  const info = model as { provider?: string; modelId?: string }
  return getReasoningSupport(info.modelId ?? '', info.provider)?.kind === 'openai-reasoning'
}

function isRetryableBadRequest(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('bad request') || message.includes('400')
}

/** Strip a surrounding markdown code fence (``` or ```json) if present. */
export function extractJsonText(rawText: string): string {
  const fenceMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  return fenceMatch ? fenceMatch[1].trim() : rawText.trim()
}

/**
 * Make a non-streaming LLM call with a single user message and parse the
 * response as JSON validated against `schema`.
 *
 * Never throws; all failure modes (LLM error, unparseable JSON, schema
 * violation) are returned as `err`.
 */
export async function generateStructured<Schema extends z.ZodType>(
  model: LanguageModel,
  prompt: string,
  schema: Schema,
  options: GenerateStructuredOptions = {},
): Promise<Result<z.infer<Schema>>> {
  const messages = [{ role: 'user' as const, content: prompt }]

  const callOptions: LLMCallOptions = {
    ...(options.temperature !== undefined && !isOpenAIReasoningModel(model)
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  }

  let llmResult = await generateResponse(model, messages, callOptions)
  if (!llmResult.ok && isRetryableBadRequest(llmResult.error)) {
    // Retryable 400: drop the sampling options and try once more. The abort
    // signal is kept so cancellation still works during the fallback call.
    llmResult = await generateResponse(
      model,
      messages,
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    )
  }

  if (!llmResult.ok) {
    return err(new Error(`Structured LLM call failed: ${llmResult.error.message}`))
  }

  const rawText = llmResult.value.text.trim()
  const jsonText = extractJsonText(rawText)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return err(
      new Error(
        `Failed to parse structured response as JSON: ${rawText.slice(0, 200)}${
          rawText.length > 200 ? '...' : ''
        }`,
      ),
    )
  }

  const validation = schema.safeParse(parsed)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    return err(new Error(`Structured response failed schema validation: ${issues}`))
  }

  return ok(validation.data as z.infer<Schema>)
}
