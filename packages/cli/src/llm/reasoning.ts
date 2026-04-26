/**
 * Reasoning / adaptive-thinking translation.
 *
 * Translates the unified `reasoningEffort` knob on `LLMCallOptions` into the
 * provider-specific `providerOptions` shape consumed by the Vercel AI SDK.
 *
 * - Anthropic adaptive thinking (Claude Opus 4.6+, Sonnet 4.6+):
 *     `providerOptions.anthropic = { thinking: { type: 'adaptive' }, effort }`
 *   (Required mode on Opus 4.7; recommended replacement for the deprecated
 *   `thinking.type: 'enabled'` + `budget_tokens` shape.)
 * - OpenAI reasoning (o-series and GPT-5 family):
 *     `providerOptions.openai = { reasoningEffort }`
 *
 * The unified enum has five levels (`minimal | low | medium | high | max`).
 * Values that aren't part of a given provider's accepted set are clamped to
 * the closest level so the user-facing semantics ("more effort = more
 * thinking") hold across providers:
 *
 * - `'minimal'`: passes through to OpenAI; clamps to `'low'` for Anthropic.
 * - `'max'`: passes through to Anthropic; clamps to `'high'` for OpenAI.
 *
 * Models that don't support reasoning are silent no-ops.
 */

import type { LanguageModel } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { getReasoningSupport } from './model-capabilities'
import type { ReasoningEffort } from './types'

type AnthropicEffort = 'low' | 'medium' | 'high' | 'max'
type OpenAIEffort = 'minimal' | 'low' | 'medium' | 'high'

const ANTHROPIC_EFFORT_MAP: Record<ReasoningEffort, AnthropicEffort> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

const OPENAI_EFFORT_MAP: Record<ReasoningEffort, OpenAIEffort> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
}

export interface ReasoningProviderOptions {
  /**
   * Provider-options object to merge into `streamText`/`generateText` calls.
   * `undefined` when the model does not support reasoning or no effort is set.
   */
  providerOptions?: Record<string, JSONObject>
  /**
   * True iff caller must pin `temperature = 1`. Anthropic thinking traditionally
   * required this; the adaptive-thinking docs don't explicitly mandate it but
   * we keep it as a safe default.
   */
  forceTemperatureOne: boolean
}

/**
 * Build `providerOptions` for adaptive thinking / reasoning effort based on
 * the model's registered capability.
 */
export function buildReasoningProviderOptions(
  model: LanguageModel,
  reasoningEffort: ReasoningEffort | undefined,
): ReasoningProviderOptions {
  if (!reasoningEffort) return { forceTemperatureOne: false }

  const info = model as { provider?: unknown; modelId?: unknown }
  const modelId = typeof info.modelId === 'string' ? info.modelId : ''
  const provider = typeof info.provider === 'string' ? info.provider : undefined

  const support = getReasoningSupport(modelId, provider)
  if (!support) return { forceTemperatureOne: false }

  if (support.kind === 'anthropic-adaptive') {
    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: ANTHROPIC_EFFORT_MAP[reasoningEffort],
        },
      },
      forceTemperatureOne: true,
    }
  }

  // openai-reasoning
  return {
    providerOptions: {
      openai: { reasoningEffort: OPENAI_EFFORT_MAP[reasoningEffort] },
    },
    forceTemperatureOne: false,
  }
}
