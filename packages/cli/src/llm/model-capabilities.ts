/**
 * Model Capability Registry
 *
 * Maps known model IDs to their context window sizes so the agent can
 * proactively manage its context budget without requiring manual config.
 * Capabilities are intentionally keyed by model ID only, not provider, so the
 * same model config applies across OpenAI API, ChatGPT subscription, and
 * OpenAI-compatible providers when they expose the same model ID.
 *
 * Data sourced from arena.ai/code, kilo.ai/leaderboard, and official docs.
 * Last updated: 2025-06-15.
 *
 * Lookup uses exact match first, then longest prefix match (e.g.
 * "claude-sonnet-4" matches "claude-sonnet-4-latest").
 */

/**
 * Reasoning style supported by a model.
 *
 *  - `anthropic-adaptive`: Anthropic adaptive thinking with effort parameter
 *    (`providerOptions.anthropic = { thinking: { type: 'adaptive' }, effort }`).
 *    Available on Opus 4.6+, Sonnet 4.6+. Replaces the deprecated
 *    `thinking.type: 'enabled'` + `budget_tokens` shape.
 *  - `openai-reasoning`: OpenAI reasoning effort
 *    (`providerOptions.openai.reasoningEffort`).
 */
export type ReasoningKind = 'anthropic-adaptive' | 'openai-reasoning'

interface ModelCapability {
  /** Context window size in tokens. */
  contextWindowTokens: number
  /** Reasoning style this model supports, if any. */
  reasoning?: { kind: ReasoningKind }
}

const ANTHROPIC_ADAPTIVE: { kind: ReasoningKind } = { kind: 'anthropic-adaptive' }
const OPENAI_REASONING: { kind: ReasoningKind } = { kind: 'openai-reasoning' }

const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // ── Anthropic — 1M context (Opus 4.6+, Sonnet 4.6) ─────────────────
  'claude-opus-4-7': {
    contextWindowTokens: 1_000_000,
    reasoning: ANTHROPIC_ADAPTIVE,
  },
  'claude-opus-4-6': {
    contextWindowTokens: 1_000_000,
    reasoning: ANTHROPIC_ADAPTIVE,
  },
  'claude-opus-4-6-thinking': {
    contextWindowTokens: 1_000_000,
    reasoning: ANTHROPIC_ADAPTIVE,
  },
  'claude-sonnet-4-6': {
    contextWindowTokens: 1_000_000,
    reasoning: ANTHROPIC_ADAPTIVE,
  },

  // ── Anthropic — 200K context (Opus 4.x, Sonnet 4.x, Haiku 4.x) ─────
  // Pre-4.6 models only support the deprecated `thinking.type: 'enabled'` +
  // `budget_tokens` shape, which we no longer wire up. Reasoning is a no-op.
  'claude-opus-4-5': { contextWindowTokens: 200_000 },
  'claude-opus-4-1': { contextWindowTokens: 200_000 },
  'claude-opus-4': { contextWindowTokens: 200_000 },
  'claude-sonnet-4-5': { contextWindowTokens: 200_000 },
  'claude-sonnet-4': { contextWindowTokens: 200_000 },
  'claude-sonnet-4-20250514': { contextWindowTokens: 200_000 },
  'claude-haiku-4-5': { contextWindowTokens: 200_000 },
  'claude-haiku-4': { contextWindowTokens: 200_000 },

  // ── OpenAI — GPT-5.5 series (1.05M context) ────────────────────────
  'gpt-5.5': { contextWindowTokens: 1_050_000, reasoning: OPENAI_REASONING },

  // ── OpenAI — GPT-5 series (1.05M context) ──────────────────────────
  'gpt-5.4': { contextWindowTokens: 1_050_000, reasoning: OPENAI_REASONING },
  'gpt-5.4-mini': {
    contextWindowTokens: 1_100_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.4-mini-high': {
    contextWindowTokens: 1_100_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.4-pro': {
    contextWindowTokens: 1_050_000,
    reasoning: OPENAI_REASONING,
  },

  // ── OpenAI — GPT-5 medium variants (1.1M context) ──────────────────
  'gpt-5.4-medium': {
    contextWindowTokens: 1_100_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5-medium': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },

  // ── OpenAI — GPT-5.3 / 5.2 / 5.1 series (400K context) ─────────────
  'gpt-5.3-codex': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.2': { contextWindowTokens: 400_000, reasoning: OPENAI_REASONING },
  'gpt-5.2-codex': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.1': { contextWindowTokens: 400_000, reasoning: OPENAI_REASONING },
  'gpt-5.1-codex': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.1-codex-mini': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },
  'gpt-5.1-medium': {
    contextWindowTokens: 400_000,
    reasoning: OPENAI_REASONING,
  },

  // ── Google — Gemini 3.x series (1M context) ────────────────────────
  'gemini-3.1-pro': { contextWindowTokens: 1_000_000 },
  'gemini-3-pro': { contextWindowTokens: 1_000_000 },
  'gemini-3-flash': { contextWindowTokens: 1_000_000 },
  'gemini-3.1-flash-lite': { contextWindowTokens: 1_000_000 },
  'gemini-2.5-pro': { contextWindowTokens: 1_000_000 },
  'gemini-2.5-flash': { contextWindowTokens: 1_000_000 },

  // ── xAI — Grok series (256K–2M context) ────────────────────────────
  'grok-4.20': { contextWindowTokens: 2_000_000 },
  'grok-4.1': { contextWindowTokens: 2_000_000 },
  'grok-4-fast': { contextWindowTokens: 2_000_000 },
  'grok-code-fast-1': { contextWindowTokens: 256_000 },

  // ── Z.ai — GLM series (~200K context) ──────────────────────────────
  'glm-5.1': { contextWindowTokens: 202_800 },
  'glm-5': { contextWindowTokens: 202_800 },
  'glm-4.7': { contextWindowTokens: 202_800 },
  'glm-4.6': { contextWindowTokens: 204_800 },

  // ── Moonshot — Kimi K2 series (262K context) ───────────────────────
  'kimi-k2.5': { contextWindowTokens: 262_100 },
  'kimi-k2.5-thinking': { contextWindowTokens: 262_100 },
  'kimi-k2.5-instant': { contextWindowTokens: 262_100 },
  'kimi-k2-thinking-turbo': { contextWindowTokens: 262_100 },

  // ── MiniMax — M2 series (~196K context) ────────────────────────────
  'minimax-m2.7': { contextWindowTokens: 196_600 },
  'minimax-m2.5': { contextWindowTokens: 196_600 },
  'minimax-m2.1': { contextWindowTokens: 196_600 },
  'minimax-m2': { contextWindowTokens: 196_600 },

  // ── Alibaba — Qwen 3.x series (262K–1M context) ────────────────────
  'qwen3.6-plus': { contextWindowTokens: 1_000_000 },
  'qwen3.5': { contextWindowTokens: 262_100 },
  'qwen3.5-397b': { contextWindowTokens: 262_100 },
  'qwen3.5-122b': { contextWindowTokens: 262_100 },
  'qwen3.5-27b': { contextWindowTokens: 262_100 },
  'qwen3.5-35b': { contextWindowTokens: 262_100 },
  'qwen3-coder': { contextWindowTokens: 262_100 },
  'qwen3-coder-480b': { contextWindowTokens: 262_100 },
  'qwen3-coder-plus': { contextWindowTokens: 262_100 },
  'qwen3-coder-next': { contextWindowTokens: 262_100 },

  // ── DeepSeek — V3.2 series (163.8K context) ────────────────────────
  'deepseek-v3.2': { contextWindowTokens: 163_840 },
  'deepseek-v3.2-thinking': { contextWindowTokens: 163_840 },
  'deepseek-v3.2-exp': { contextWindowTokens: 163_840 },
  'deepseek-v3.1': { contextWindowTokens: 163_840 },

  // ── Mistral — Devstral / Large series (256K context) ───────────────
  'mistral-large-3': { contextWindowTokens: 256_000 },
  'devstral-2': { contextWindowTokens: 256_000 },

  // ── NVIDIA — Nemotron series ───────────────────────────────────────
  'nemotron-3-super': { contextWindowTokens: 128_000 },
}

/**
 * Look up a model's capability entry using exact then longest-prefix matching,
 * supporting `provider/name` namespaced variants.
 */
function lookupCapability(modelName: string): ModelCapability | null {
  if (!modelName) return null

  const candidateNames = Array.from(
    new Set([modelName, ...extractNamespacedModelVariants(modelName)]),
  )

  for (const candidate of candidateNames) {
    const exact = MODEL_CAPABILITIES[candidate]
    if (exact) return exact
  }

  let best: ModelCapability | null = null
  let bestKeyLen = 0

  for (const candidate of candidateNames) {
    for (const [key, cap] of Object.entries(MODEL_CAPABILITIES)) {
      if (candidate.startsWith(key) && key.length > bestKeyLen) {
        best = cap
        bestKeyLen = key.length
      }
    }
  }

  return best
}

/**
 * Look up the context window size for a given model ID.
 *
 * Search order:
 *   1. Exact match on the full model ID
 *   2. Longest prefix match against known model keys
 *
 * Returns null if the model is not recognised.
 *
 * @param modelName — The model identifier (e.g. "claude-sonnet-4-latest")
 * @param _provider — Ignored. Reserved for backwards-compatible call sites.
 */
export function getContextWindowTokens(modelName: string, _provider?: string): number | null {
  const cap = lookupCapability(modelName)
  return cap ? cap.contextWindowTokens : null
}

/**
 * Look up reasoning support for a given model ID.
 *
 * Returns the reasoning kind (`anthropic-adaptive` or `openai-reasoning`) the
 * model supports, or `null` if it does not support reasoning at all.
 *
 * @param modelName — The model identifier
 * @param _provider — Ignored. Reserved for backwards-compatible call sites.
 */
export function getReasoningSupport(
  modelName: string,
  _provider?: string,
): { kind: ReasoningKind } | null {
  const cap = lookupCapability(modelName)
  return cap?.reasoning ?? null
}

function extractNamespacedModelVariants(modelName: string): string[] {
  const slashIndex = modelName.indexOf('/')
  if (slashIndex === -1 || slashIndex === modelName.length - 1) {
    return []
  }

  return [modelName.slice(slashIndex + 1)]
}
