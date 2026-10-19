/** Translate shared model capabilities into protocol-specific SDK options. */
import type { LanguageModel } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { getModelDescriptor, normalizeReasoningEffort } from '@ouroboros/shared'
import type { ReasoningEffort } from './types'

export interface ReasoningProviderOptions {
  providerOptions?: Record<string, JSONObject>
  forceTemperatureOne: boolean
  omitTemperature?: boolean
}
export function buildReasoningProviderOptions(
  model: LanguageModel,
  reasoningEffort: ReasoningEffort | undefined,
): ReasoningProviderOptions {
  const info = model as { modelId?: string; provider?: string }
  const modelId = info.modelId ?? ''
  const provider = info.provider ?? ''
  const cap = getModelDescriptor(modelId, provider)
  const base: ReasoningProviderOptions = {
    forceTemperatureOne: false,
    ...(cap?.omitSampling ? { omitTemperature: true } : {}),
  }
  if (!cap?.reasoningKind || !reasoningEffort) return base
  const effort = normalizeReasoningEffort(reasoningEffort, cap.reasoningEfforts)
  if (!effort) return base
  if (cap.reasoningKind === 'anthropic-adaptive') {
    return {
      ...base,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort } },
      forceTemperatureOne: !cap.omitSampling,
    }
  }
  const key = provider.startsWith('openai-compatible') ? 'openaiCompatible' : 'openai'
  return {
    ...base,
    providerOptions: {
      [key]: {
        reasoningEffort: effort,
        ...(key === 'openai' && !/^gpt-[56]/.test(modelId) ? { forceReasoning: true } : {}),
      },
    },
  }
}
