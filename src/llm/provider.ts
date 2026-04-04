/**
 * LLM Provider Factory
 *
 * Creates Vercel AI SDK model instances based on configuration.
 * Supports Anthropic, OpenAI, and OpenAI-compatible endpoints.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV1 } from 'ai'
import type { OuroborosConfig } from '@src/config'
import { type Result, ok, err } from '@src/types'

/** The subset of OuroborosConfig that the provider factory needs */
export type ModelConfig = OuroborosConfig['model']

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'openai-compatible'] as const

/**
 * Create a Vercel AI SDK model instance from the given model configuration.
 *
 * API keys are read from environment variables:
 *   - Anthropic: ANTHROPIC_API_KEY
 *   - OpenAI / OpenAI-compatible: OPENAI_API_KEY
 *
 * @param config - The model section of the Ouroboros config
 * @returns A Result containing either a LanguageModel or a descriptive error
 */
export function createProvider(config: ModelConfig): Result<LanguageModelV1> {
  const { provider, name: modelId } = config

  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        return err(
          new Error(
            'Missing ANTHROPIC_API_KEY environment variable. ' +
              'Set it to your Anthropic API key to use the Anthropic provider.'
          )
        )
      }
      const anthropic = createAnthropic({ apiKey })
      return ok(anthropic(modelId))
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) {
        return err(
          new Error(
            'Missing OPENAI_API_KEY environment variable. ' +
              'Set it to your OpenAI API key to use the OpenAI provider.'
          )
        )
      }
      const openai = createOpenAI({ apiKey })
      return ok(openai(modelId))
    }

    case 'openai-compatible': {
      if (!config.baseUrl) {
        return err(
          new Error(
            'OpenAI-compatible provider requires a baseUrl in the model configuration. ' +
              'Set model.baseUrl in .ouroboros or OUROBOROS_MODEL_BASE_URL environment variable.'
          )
        )
      }
      const apiKey = process.env.OPENAI_API_KEY ?? ''
      const openai = createOpenAI({
        baseURL: config.baseUrl,
        apiKey: apiKey || undefined
      })
      return ok(openai(modelId))
    }

    default: {
      // Exhaustiveness — if a new provider is added to the config schema
      // but not handled here, TypeScript will catch it at compile time.
      const _exhaustive: never = provider
      return err(
        new Error(
          `Unsupported LLM provider: "${_exhaustive}". ` + `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`
        )
      )
    }
  }
}
