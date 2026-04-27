/**
 * LLM Provider Factory
 *
 * Creates Vercel AI SDK model instances based on configuration.
 * Supports Anthropic, OpenAI, and OpenAI-compatible endpoints.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import {
  createOpenAIChatGPTFetch,
  isSupportedOpenAIChatGPTModel,
  OPENAI_CHATGPT_OAUTH_DUMMY_KEY,
  OPENAI_CHATGPT_PROVIDER,
} from '@src/auth/openai-chatgpt'
import { getAuth } from '@src/auth'
import type { LanguageModel } from 'ai'
import type { OuroborosConfig } from '@src/config'
import { type Result, ok, err } from '@src/types'

export type ModelConfig = OuroborosConfig['model']

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'openai-chatgpt'] as const
const DEBUG_HTTP_ENV = 'OUROBOROS_DEBUG_HTTP'
type OpenAIFetch = NonNullable<Parameters<typeof createOpenAI>[0]>['fetch']

/**
 * Create a Vercel AI SDK model instance from the given model configuration.
 *
 * API keys are resolved in this order:
 *   - Anthropic: ANTHROPIC_API_KEY, then model.apiKey
 *   - OpenAI: OPENAI_API_KEY, then model.apiKey
 *   - OpenAI-compatible: OUROBOROS_OPENAI_COMPATIBLE_API_KEY, then model.apiKey
 *   - OpenAI ChatGPT: OAuth auth store managed via `ouroboros auth`
 *
 * @returns A Result containing either a LanguageModel or a descriptive error
 */
export function createProvider(
  modelConfig: ModelConfig,
  configDir?: string,
): Result<LanguageModel> {
  const { provider, name: modelId } = modelConfig

  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? modelConfig.apiKey
      if (!apiKey) {
        return err(
          new Error(
            'Missing Anthropic API key. Set ANTHROPIC_API_KEY or add model.apiKey to .ouroboros.',
          ),
        )
      }
      const anthropic = createAnthropic({ apiKey })
      return ok(anthropic(modelId))
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY ?? modelConfig.apiKey
      if (!apiKey) {
        return err(
          new Error(
            'Missing OpenAI API key. Set OPENAI_API_KEY or add model.apiKey to .ouroboros.',
          ),
        )
      }
      const openai = createOpenAI({
        apiKey,
        fetch: createProviderFetch('openai'),
      })
      return ok(openai(modelId))
    }

    case 'openai-compatible': {
      if (!modelConfig.baseUrl) {
        return err(
          new Error(
            'OpenAI-compatible provider requires a baseUrl in the model configuration. ' +
              'Set model.baseUrl in .ouroboros or OUROBOROS_MODEL_BASE_URL environment variable.',
          ),
        )
      }
      const apiKey = process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY ?? modelConfig.apiKey ?? ''
      const openai = createOpenAI({
        baseURL: modelConfig.baseUrl,
        apiKey: apiKey || undefined,
        name: 'openai-compatible',
        fetch: createProviderFetch('openai-compatible'),
      })

      const apiMode = modelConfig.apiMode ?? 'chat'

      switch (apiMode) {
        case 'chat':
          return ok(openai.chat(modelId))
        case 'completion':
          return ok(openai.completion(modelId))
        case 'responses':
          return ok(openai.responses(modelId))
        default: {
          const _exhaustive: never = apiMode
          return err(new Error(`Unsupported OpenAI-compatible apiMode: "${_exhaustive}"`))
        }
      }
    }

    case OPENAI_CHATGPT_PROVIDER: {
      if (!isSupportedOpenAIChatGPTModel(modelId)) {
        return err(
          new Error(
            `Unsupported ChatGPT subscription model "${modelId}". ` +
              'Choose one of the supported Codex models in settings or via --model.',
          ),
        )
      }
      const authResult = getAuth(OPENAI_CHATGPT_PROVIDER, configDir)
      if (!authResult.ok) {
        return authResult
      }
      if (!authResult.value) {
        return err(
          new Error(
            'Missing ChatGPT subscription login. Run `ouroboros auth login --provider openai-chatgpt` first.',
          ),
        )
      }

      const openai = createOpenAI({
        name: OPENAI_CHATGPT_PROVIDER,
        apiKey: OPENAI_CHATGPT_OAUTH_DUMMY_KEY,
        fetch: createOpenAIChatGPTFetch(createProviderFetch(OPENAI_CHATGPT_PROVIDER), configDir),
      })
      return ok(openai.responses(modelId))
    }

    default: {
      // Exhaustiveness — if a new provider is added to the config schema
      // but not handled here, TypeScript will catch it at compile time.
      const _exhaustive: never = provider
      return err(
        new Error(
          `Unsupported LLM provider: "${_exhaustive}". ` +
            `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`,
        ),
      )
    }
  }
}

function createProviderFetch(provider: string): OpenAIFetch {
  const debugFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (process.env[DEBUG_HTTP_ENV] === '1') {
      const requestBody = await readRequestBody(request)
      const redactedHeaders = redactHeaders(request.headers)

      process.stderr.write(
        [
          `[http-debug] provider=${provider} request`,
          `${request.method} ${request.url}`,
          `headers=${JSON.stringify(redactedHeaders)}`,
          requestBody ? `body=${truncateForLog(requestBody)}` : 'body=<empty>',
        ].join('\n') + '\n',
      )
    }

    let response = await fetch(request)
    if (provider === 'openai-compatible') {
      response = sanitizeOpenAICompatibleResponse(response)
    }

    if (process.env[DEBUG_HTTP_ENV] === '1') {
      const responseHeaders = headersToObject(response.headers)
      const contentType = response.headers.get('content-type') ?? ''
      const shouldLogBody =
        !contentType.includes('text/event-stream') &&
        !contentType.includes('application/octet-stream')

      let responseBody = '<skipped>'
      if (shouldLogBody) {
        try {
          responseBody = truncateForLog(await response.clone().text())
        } catch (error) {
          responseBody = `<unavailable: ${error instanceof Error ? error.message : String(error)}>`
        }
      }

      process.stderr.write(
        [
          `[http-debug] provider=${provider} response`,
          `status=${response.status}`,
          `headers=${JSON.stringify(responseHeaders)}`,
          `body=${responseBody}`,
        ].join('\n') + '\n',
      )
    }

    return response
  }

  const providerFetch = debugFetch as unknown as typeof fetch
  providerFetch.preconnect = fetch.preconnect.bind(fetch)
  return providerFetch as OpenAIFetch
}

function sanitizeOpenAICompatibleResponse(response: Response): Response {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !response.body) {
    return response
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = response.body!.getReader()

      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              if (buffer.length > 0) {
                controller.enqueue(encoder.encode(sanitizeSseChunk(buffer)))
              }
              controller.close()
              return
            }

            buffer += decoder.decode(value, { stream: true })
            let splitIndex = buffer.indexOf('\n\n')
            while (splitIndex !== -1) {
              const rawEvent = buffer.slice(0, splitIndex + 2)
              controller.enqueue(encoder.encode(sanitizeSseChunk(rawEvent)))
              buffer = buffer.slice(splitIndex + 2)
              splitIndex = buffer.indexOf('\n\n')
            }

            pump()
          })
          .catch((error) => controller.error(error))
      }

      pump()
    },
  })

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function sanitizeSseChunk(chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data: ')) return line
      const payload = line.slice(6)
      if (payload === '[DONE]') return line

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        if (patchMalformedToolCallTypes(parsed)) {
          return `data: ${JSON.stringify(parsed)}`
        }
      } catch {
        return line
      }

      return line
    })
    .join('\n')
}

export function patchMalformedToolCallTypes(payload: Record<string, unknown>): boolean {
  const choices = payload.choices
  if (!Array.isArray(choices)) return false

  let changed = false
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const delta = (choice as { delta?: unknown }).delta
    if (!delta || typeof delta !== 'object') continue
    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls
    if (!Array.isArray(toolCalls)) continue

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue
      const record = toolCall as { type?: unknown; function?: unknown }
      if (record.type === '' && record.function && typeof record.function === 'object') {
        record.type = 'function'
        changed = true
      }
    }
  }

  return changed
}

async function readRequestBody(request: Request): Promise<string> {
  try {
    return await request.clone().text()
  } catch {
    return ''
  }
}

function redactHeaders(headers: Headers): Record<string, string> {
  const result = headersToObject(headers)
  for (const key of Object.keys(result)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'x-grid-key') {
      result[key] = redactSecret(result[key])
    }
  }
  return result
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    result[key] = value
  }
  return result
}

function redactSecret(value: string): string {
  if (value.length <= 12) return '<redacted>'
  return `${value.slice(0, 10)}...<redacted>...${value.slice(-4)}`
}

function truncateForLog(value: string, maxLength = 2000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated>` : value
}
