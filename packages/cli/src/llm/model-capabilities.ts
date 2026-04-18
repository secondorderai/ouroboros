/**
 * Model Capability Registry
 *
 * Maps known model IDs to their context window sizes so the agent can
 * proactively manage its context budget without requiring manual config.
 *
 * Data sourced from arena.ai/code, kilo.ai/leaderboard, and official docs.
 * Last updated: 2025-06-15.
 *
 * Lookup uses exact match first, then longest prefix match (e.g.
 * "claude-sonnet-4" matches "claude-sonnet-4-latest").
 */

interface ModelCapability {
  /** Context window size in tokens. */
  contextWindowTokens: number
  /** Optional provider namespace for disambiguation. */
  provider?: string
}

const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // ── Anthropic — 1M context (Opus 4.6+, Sonnet 4.6) ─────────────────
  'claude-opus-4-7': { contextWindowTokens: 1_000_000, provider: 'anthropic' },
  'claude-opus-4-6': { contextWindowTokens: 1_000_000, provider: 'anthropic' },
  'claude-opus-4-6-thinking': { contextWindowTokens: 1_000_000, provider: 'anthropic' },
  'claude-sonnet-4-6': { contextWindowTokens: 1_000_000, provider: 'anthropic' },

  // ── Anthropic — 200K context (Opus 4.x, Sonnet 4.x, Haiku 4.x) ─────
  'claude-opus-4-5': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-opus-4-1': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-opus-4': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-sonnet-4-5': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-sonnet-4': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-sonnet-4-20250514': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-haiku-4-5': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-haiku-4': { contextWindowTokens: 200_000, provider: 'anthropic' },

  // ── Anthropic — legacy 200K (Claude 3 series) ──────────────────────
  'claude-3-5-sonnet-20241022': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-5-sonnet-20240620': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-5-sonnet': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-5-haiku-20241022': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-5-haiku': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-opus-20240229': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-opus': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-sonnet-20240229': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-sonnet': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-haiku-20240307': { contextWindowTokens: 200_000, provider: 'anthropic' },
  'claude-3-haiku': { contextWindowTokens: 200_000, provider: 'anthropic' },

  // ── OpenAI — GPT-5 series (1.05M context) ──────────────────────────
  'gpt-5.4': { contextWindowTokens: 1_050_000, provider: 'openai' },
  'gpt-5.4-mini': { contextWindowTokens: 1_100_000, provider: 'openai' },
  'gpt-5.4-mini-high': { contextWindowTokens: 1_100_000, provider: 'openai' },
  'gpt-5.4-pro': { contextWindowTokens: 1_050_000, provider: 'openai' },

  // ── OpenAI — GPT-5 medium variants (1.1M context) ──────────────────
  'gpt-5.4-medium': { contextWindowTokens: 1_100_000, provider: 'openai' },
  'gpt-5-medium': { contextWindowTokens: 400_000, provider: 'openai' },

  // ── OpenAI — GPT-5.3 / 5.2 / 5.1 series (400K context) ─────────────
  'gpt-5.3-codex': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.2': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.2-codex': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.1': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.1-codex': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.1-codex-mini': { contextWindowTokens: 400_000, provider: 'openai' },
  'gpt-5.1-medium': { contextWindowTokens: 400_000, provider: 'openai' },

  // ── OpenAI — reasoning models (o-series) ───────────────────────────
  o1: { contextWindowTokens: 200_000, provider: 'openai' },
  'o1-mini': { contextWindowTokens: 128_000, provider: 'openai' },
  o3: { contextWindowTokens: 200_000, provider: 'openai' },
  'o3-mini': { contextWindowTokens: 200_000, provider: 'openai' },
  'o4-mini': { contextWindowTokens: 200_000, provider: 'openai' },

  // ── OpenAI — legacy (gpt-4o / gpt-4) ──────────────────────────────
  'gpt-4o': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4o-2024': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4o-mini': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4o-mini-2024': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4-turbo': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4-turbo-2024': { contextWindowTokens: 128_000, provider: 'openai' },
  'gpt-4': { contextWindowTokens: 8_192, provider: 'openai' },
  'gpt-3.5-turbo': { contextWindowTokens: 16_385, provider: 'openai' },

  // ── Google — Gemini 3.x series (1M context) ────────────────────────
  'gemini-3.1-pro': { contextWindowTokens: 1_000_000, provider: 'google' },
  'gemini-3-pro': { contextWindowTokens: 1_000_000, provider: 'google' },
  'gemini-3-flash': { contextWindowTokens: 1_000_000, provider: 'google' },
  'gemini-3.1-flash-lite': { contextWindowTokens: 1_000_000, provider: 'google' },
  'gemini-2.5-pro': { contextWindowTokens: 1_000_000, provider: 'google' },
  'gemini-2.5-flash': { contextWindowTokens: 1_000_000, provider: 'google' },

  // ── xAI — Grok series (256K–2M context) ────────────────────────────
  'grok-4.20': { contextWindowTokens: 2_000_000, provider: 'xai' },
  'grok-4.1': { contextWindowTokens: 2_000_000, provider: 'xai' },
  'grok-4-fast': { contextWindowTokens: 2_000_000, provider: 'xai' },
  'grok-code-fast-1': { contextWindowTokens: 256_000, provider: 'xai' },

  // ── Z.ai — GLM series (~200K context) ──────────────────────────────
  'glm-5.1': { contextWindowTokens: 202_800, provider: 'zai' },
  'glm-5': { contextWindowTokens: 202_800, provider: 'zai' },
  'glm-4.7': { contextWindowTokens: 202_800, provider: 'zai' },
  'glm-4.6': { contextWindowTokens: 204_800, provider: 'zai' },

  // ── Moonshot — Kimi K2 series (262K context) ───────────────────────
  'kimi-k2.5': { contextWindowTokens: 262_100, provider: 'moonshot' },
  'kimi-k2.5-thinking': { contextWindowTokens: 262_100, provider: 'moonshot' },
  'kimi-k2.5-instant': { contextWindowTokens: 262_100, provider: 'moonshot' },
  'kimi-k2-thinking-turbo': { contextWindowTokens: 262_100, provider: 'moonshot' },

  // ── MiniMax — M2 series (~196K context) ────────────────────────────
  'minimax-m2.7': { contextWindowTokens: 196_600, provider: 'minimax' },
  'minimax-m2.5': { contextWindowTokens: 196_600, provider: 'minimax' },
  'minimax-m2.1': { contextWindowTokens: 196_600, provider: 'minimax' },
  'minimax-m2': { contextWindowTokens: 196_600, provider: 'minimax' },

  // ── Alibaba — Qwen 3.x series (262K–1M context) ────────────────────
  'qwen3.6-plus': { contextWindowTokens: 1_000_000, provider: 'qwen' },
  'qwen3.5': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3.5-397b': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3.5-122b': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3.5-27b': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3.5-35b': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3-coder': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3-coder-480b': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3-coder-plus': { contextWindowTokens: 262_100, provider: 'qwen' },
  'qwen3-coder-next': { contextWindowTokens: 262_100, provider: 'qwen' },

  // ── DeepSeek — V3.2 series (163.8K context) ────────────────────────
  'deepseek-v3.2': { contextWindowTokens: 163_840, provider: 'deepseek' },
  'deepseek-v3.2-thinking': { contextWindowTokens: 163_840, provider: 'deepseek' },
  'deepseek-v3.2-exp': { contextWindowTokens: 163_840, provider: 'deepseek' },
  'deepseek-v3.1': { contextWindowTokens: 163_840, provider: 'deepseek' },

  // ── Mistral — Devstral / Large series (256K context) ───────────────
  'mistral-large-3': { contextWindowTokens: 256_000, provider: 'mistral' },
  'devstral-2': { contextWindowTokens: 256_000, provider: 'mistral' },

  // ── Xiaomi — Mimo series (262K–1M context) ─────────────────────────
  'mimo-v2-pro': { contextWindowTokens: 1_000_000, provider: 'xiaomi' },
  'mimo-v2-flash': { contextWindowTokens: 262_100, provider: 'xiaomi' },

  // ── NVIDIA — Nemotron series ───────────────────────────────────────
  'nemotron-3-super': { contextWindowTokens: 128_000, provider: 'nvidia' },

  // ── Other notable models ───────────────────────────────────────────
  'step-3.5-flash': { contextWindowTokens: 256_000, provider: 'stepfun' },
  'elephant-alpha': { contextWindowTokens: 256_000, provider: 'openrouter' },
  'kat-coder-pro': { contextWindowTokens: 256_000, provider: 'kwai' },
  'mercury-2': { contextWindowTokens: 128_000, provider: 'inception' },
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
 * @param _provider — Optional provider hint for future disambiguation
 */
export function getContextWindowTokens(modelName: string, _provider?: string): number | null {
  const candidateNames = Array.from(
    new Set([modelName, ...extractNamespacedModelVariants(modelName)]),
  )

  // 1. Exact match
  for (const candidate of candidateNames) {
    const exact = MODEL_CAPABILITIES[candidate]
    if (exact) return exact.contextWindowTokens
  }

  // 2. Prefix match — find the longest matching key
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

  return best ? best.contextWindowTokens : null
}

function extractNamespacedModelVariants(modelName: string): string[] {
  const slashIndex = modelName.indexOf('/')
  if (slashIndex === -1 || slashIndex === modelName.length - 1) {
    return []
  }

  return [modelName.slice(slashIndex + 1)]
}
