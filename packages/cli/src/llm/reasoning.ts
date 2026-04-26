/**
 * Reasoning / extended-thinking translation.
 *
 * Translates the per-provider knobs on `LLMCallOptions` (`thinkingBudgetTokens`
 * for Anthropic, `reasoningEffort` for OpenAI) into the provider-specific
 * `providerOptions` shape consumed by the Vercel AI SDK.
 *
 * Wrong-knob-for-model is silently ignored so users can swap models without
 * editing config.
 */

import type { LanguageModel } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { getReasoningSupport } from './model-capabilities'
import type { ReasoningEffort } from './types'

/** Minimum thinking budget Anthropic accepts. */
const MIN_THINKING_BUDGET_TOKENS = 1024
/** Slack we leave between thinking budget and `max_tokens`. */
const THINKING_BUDGET_SLACK = 1024

export interface ReasoningProviderOptions {
  /**
   * Provider-options object to merge into `streamText`/`generateText` calls.
   * `undefined` when the model does not support reasoning or no knob is set.
   */
  providerOptions?: Record<string, JSONObject>
  /** True iff caller must pin `temperature = 1` (Anthropic thinking constraint). */
  forceTemperatureOne: boolean
}

/**
 * Build `providerOptions` for reasoning/thinking based on the model's
 * registered capability.
 */
export function buildReasoningProviderOptions(
  model: LanguageModel,
  thinkingBudgetTokens: number | undefined,
  reasoningEffort: ReasoningEffort | undefined,
  maxOutputTokens: number | undefined,
): ReasoningProviderOptions {
  const info = model as { provider?: unknown; modelId?: unknown }
  const modelId = typeof info.modelId === 'string' ? info.modelId : ''
  const provider = typeof info.provider === 'string' ? info.provider : undefined

  const support = getReasoningSupport(modelId, provider)
  if (!support) return { forceTemperatureOne: false }

  if (
    support.kind === 'anthropic-thinking' &&
    typeof thinkingBudgetTokens === 'number' &&
    Number.isInteger(thinkingBudgetTokens) &&
    thinkingBudgetTokens > 0
  ) {
    const budget = clampThinkingBudget(thinkingBudgetTokens, maxOutputTokens)
    return {
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: budget } },
      },
      forceTemperatureOne: true,
    }
  }

  if (support.kind === 'openai-reasoning' && reasoningEffort) {
    return {
      providerOptions: { openai: { reasoningEffort } },
      forceTemperatureOne: false,
    }
  }

  return { forceTemperatureOne: false }
}

function clampThinkingBudget(budget: number, maxOutputTokens: number | undefined): number {
  if (typeof maxOutputTokens === 'number' && budget >= maxOutputTokens) {
    return Math.max(MIN_THINKING_BUDGET_TOKENS, maxOutputTokens - THINKING_BUDGET_SLACK)
  }
  return budget
}
