/** Shared, browser-safe catalogue. Provider IDs are never rewritten on the wire.
 * Official model specifications verified 2026-10-19. Runtime account metadata
 * overlays subscription limits without changing API-key capabilities.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol'
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export type ReasoningKind = 'anthropic-adaptive' | 'openai-reasoning' | 'compatible-reasoning'
export type ModelLifecycle = 'current' | 'legacy' | 'deprecated' | 'retired'
export interface ModelDescriptor {
  id: string
  displayName: string
  family: string
  contextWindowTokens: number
  reasoningKind?: ReasoningKind
  reasoningEfforts: ReasoningEffort[]
  lifecycle: ModelLifecycle
  accessRestriction?: string
  sourceUrl: string
  verifiedAt: string
  omitSampling?: boolean
}
export interface ModelMigration {
  from: string
  to: string
  message: string
}
export interface ModelCatalogSnapshot {
  modelDetails: ModelDescriptor[]
  catalogSource: 'live' | 'cache' | 'bundled'
  catalogFetchedAt?: string
  catalogError?: string
}
interface LegacyCapability {
  contextWindowTokens: number
  reasoning?: { kind: ReasoningKind }
}
const ANTHROPIC_ADAPTIVE = { kind: 'anthropic-adaptive' as const }
const OPENAI_REASONING = { kind: 'openai-reasoning' as const }
const LEGACY_CAPABILITIES: Record<string, LegacyCapability> = {
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

const model = (
  id: string,
  family: string,
  contextWindowTokens: number,
  sourceUrl: string,
  reasoningKind?: ReasoningKind,
  reasoningEfforts: ReasoningEffort[] = [],
  extra: Partial<ModelDescriptor> = {},
): ModelDescriptor => ({
  id,
  displayName: id,
  family,
  contextWindowTokens,
  sourceUrl,
  reasoningKind,
  reasoningEfforts,
  lifecycle: 'current',
  verifiedAt: '2026-10-19',
  ...extra,
})
const openaiEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const claudeEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const sources = {
  openai: 'https://developers.openai.com/api/docs/guides/latest-model',
  anthropic: 'https://platform.claude.com/docs/en/models/overview',
  google: 'https://ai.google.dev/gemini-api/docs/models',
  xai: 'https://docs.x.ai/developers/models',
  glm: 'https://docs.z.ai/guides/llm/glm-5.3',
  kimi: 'https://platform.kimi.ai/docs/models',
  minimax: 'https://platform.minimax.io/docs/guides/models-intro',
  qwen: 'https://www.alibabacloud.com/help/en/model-studio/text-generation-model',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  mistral: 'https://docs.mistral.ai/models',
  nvidia: 'https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b',
}
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  ...Object.entries(LEGACY_CAPABILITIES).map(([id, cap]) =>
    model(
      id,
      id.startsWith('claude') ? 'anthropic' : id.startsWith('gpt') ? 'openai' : 'compatible',
      cap.contextWindowTokens,
      id.startsWith('claude')
        ? sources.anthropic
        : id.startsWith('gpt')
          ? sources.openai
          : id.startsWith('gemini')
            ? sources.google
            : id.startsWith('grok')
              ? sources.xai
              : id.startsWith('glm')
                ? sources.glm
                : id.startsWith('kimi')
                  ? sources.kimi
                  : id.startsWith('minimax')
                    ? sources.minimax
                    : id.startsWith('qwen')
                      ? sources.qwen
                      : id.startsWith('deepseek')
                        ? sources.deepseek
                        : id.startsWith('nemotron')
                          ? sources.nvidia
                          : sources.mistral,
      cap.reasoning?.kind,
      cap.reasoning?.kind === 'anthropic-adaptive'
        ? ['low', 'medium', 'high', 'max']
        : cap.reasoning
          ? ['minimal', 'low', 'medium', 'high']
          : [],
      {
        verifiedAt: '',
        lifecycle:
          id === 'devstral-2' || id === 'kimi-k2.5'
            ? 'deprecated'
            : [
                  'claude-opus-4',
                  'claude-sonnet-4',
                  'claude-sonnet-4-20250514',
                  'claude-opus-4-1',
                ].includes(id)
              ? 'retired'
              : 'legacy',
        omitSampling: id.startsWith('claude-opus-4-7'),
      },
    ),
  ),
  ...[
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ].map((id) =>
    model(
      id,
      'openai',
      1_050_000,
      sources.openai,
      'openai-reasoning',
      id === 'gpt-6-astra' || id === 'gpt-6.1-sol' ? openaiEfforts : ['none', ...openaiEfforts],
      { omitSampling: true },
    ),
  ),
  model(
    'gpt-daybreak-blue-latest',
    'openai',
    1_050_000,
    'https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest',
    'openai-reasoning',
    openaiEfforts,
    {
      accessRestriction:
        'Requires Daybreak access; only list when returned by the signed-in account',
      omitSampling: true,
    },
  ),
  ...['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) =>
    model(id, 'anthropic', 1_000_000, sources.anthropic, 'anthropic-adaptive', claudeEfforts, {
      omitSampling: true,
    }),
  ),
  model('gemini-4-argon', 'google', 1_048_576, sources.google, 'compatible-reasoning', [
    'low',
    'medium',
    'high',
  ]),
  ...['gemini-3.8-flash', 'gemini-3.5-flash-lite'].map((id) =>
    model(id, 'google', 1_000_000, sources.google, 'compatible-reasoning', [
      'minimal',
      'low',
      'medium',
      'high',
    ]),
  ),
  model('grok-4.7', 'xai', 500_000, sources.xai, 'compatible-reasoning', [
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  ...['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'].map((id) =>
    model(id, 'glm', 1_000_000, sources.glm, 'compatible-reasoning', ['low', 'high', 'max']),
  ),
  model('kimi-k3', 'kimi', 1_000_000, sources.kimi, 'compatible-reasoning', ['low', 'high', 'max']),
  ...['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'].map((id) =>
    model(id, 'kimi', 262_144, sources.kimi),
  ),
  model('MiniMax-M3', 'minimax', 1_000_000, sources.minimax),
  model(
    'MiniMax-M3.1-Flash-Preview',
    'minimax',
    1_000_000,
    sources.minimax,
    'compatible-reasoning',
    claudeEfforts,
    { accessRestriction: 'Preview: M Plan and MiniMax Code only' },
  ),
  ...['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'].map((id) =>
    model(id, 'qwen', 1_000_000, sources.qwen),
  ),
  ...['deepseek-flash', 'deepseek-v4-pro'].map((id) =>
    model(id, 'deepseek', 1_000_000, sources.deepseek),
  ),
  model('mistral-large-4', 'mistral', 1_000_000, sources.mistral),
  model('mistral-medium-3-5', 'mistral', 256_000, sources.mistral),
  model('nvidia/nemotron-3-ultra-550b-a55b', 'nvidia', 1_000_000, sources.nvidia),
  model(
    'nvidia/nemotron-3.5-super-vl-120b-a12b',
    'nvidia',
    262_144,
    'https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b',
    undefined,
    [],
    { accessRestriction: 'Early access; hosted NIM limit' },
  ),
]
export const SUBSCRIPTION_MODEL_IDS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const
export const RETIRED_SUBSCRIPTION_MODELS = new Set([
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
])
let subscriptionModels: readonly ModelDescriptor[] = []
export function setSubscriptionModels(models: readonly ModelDescriptor[]): void {
  subscriptionModels = models
}
function stripNamespace(id: string): string {
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
}
export function getModelDescriptor(id: string, provider?: string): ModelDescriptor | null {
  const name = stripNamespace(id).toLowerCase()
  const subscription = provider?.startsWith('openai-chatgpt') || id.startsWith('openai-chatgpt/')
  if (subscription) {
    const live = subscriptionModels.find((m) => m.id.toLowerCase() === name)
    if (live) return live
  }
  const entry = [...MODEL_CATALOG]
    .reverse()
    .filter((m) => {
      const base = stripNamespace(m.id).toLowerCase()
      return name === base || name.startsWith(base + '-')
    })
    .sort((a, b) => b.id.length - a.id.length)[0]
  if (!entry) return null
  if (subscription && (SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(entry.id)) {
    return {
      ...entry,
      contextWindowTokens: entry.id === 'gpt-6.1-sol' ? 500_000 : 272_000,
      reasoningEfforts: openaiEfforts,
    }
  }
  return entry
}
export function getContextWindowTokens(id: string, provider?: string): number | null {
  return getModelDescriptor(id, provider)?.contextWindowTokens ?? null
}
export function getReasoningSupport(id: string, provider?: string): { kind: ReasoningKind } | null {
  const kind = getModelDescriptor(id, provider)?.reasoningKind
  return kind ? { kind } : null
}
export function getReasoningEfforts(id: string, provider?: string): ReasoningEffort[] {
  return getModelDescriptor(id, provider)?.reasoningEfforts ?? []
}
export function normalizeReasoningEffort(
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.includes(effort)) return effort
  const lower = supported.filter(
    (e) => REASONING_EFFORTS.indexOf(e) <= REASONING_EFFORTS.indexOf(effort),
  )
  return lower.at(-1) ?? supported[0]
}
export function getBundledSubscriptionModels(): ModelDescriptor[] {
  return SUBSCRIPTION_MODEL_IDS.map((id) => ({
    ...MODEL_CATALOG.find((m) => m.id === id)!,
    contextWindowTokens: id === 'gpt-6.1-sol' ? 500_000 : 272_000,
    reasoningEfforts: [...openaiEfforts],
  }))
}
