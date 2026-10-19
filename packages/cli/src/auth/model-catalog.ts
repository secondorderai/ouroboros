import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getBundledSubscriptionModels,
  getModelDescriptor,
  REASONING_EFFORTS,
  setSubscriptionModels,
  type ModelCatalogSnapshot,
  type ModelDescriptor,
} from '@ouroboros/shared'
import type { AuthInfo } from './index'

export const CATALOG_TTL_MS = 10 * 60_000
export const CODEX_MODELS_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/models?client_version=0.163.0'

function isCachedDescriptor(value: unknown): value is ModelDescriptor {
  if (!value || typeof value !== 'object') return false
  const m = value as ModelDescriptor
  return (
    typeof m.id === 'string' &&
    !!m.id.trim() &&
    typeof m.displayName === 'string' &&
    m.family === 'openai' &&
    m.lifecycle === 'current' &&
    m.sourceUrl === CODEX_MODELS_ENDPOINT &&
    typeof m.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(m.verifiedAt)) &&
    Number.isSafeInteger(m.contextWindowTokens) &&
    m.contextWindowTokens > 0 &&
    (m.reasoningKind === undefined || m.reasoningKind === 'openai-reasoning') &&
    Array.isArray(m.reasoningEfforts) &&
    m.reasoningEfforts.every((e) => REASONING_EFFORTS.includes(e)) &&
    (m.accessRestriction === undefined || typeof m.accessRestriction === 'string')
  )
}

/** The version is a catalogue-protocol compatibility marker, not our app version.
 * This Codex OAuth client requires the native endpoint and a client_version.
 * Verified 2026-10-19; public SIWC credentials are a separate authentication flow.
 */
export class SubscriptionModelCatalog {
  private cache = new Map<string, ModelCatalogSnapshot>()
  private errors = new Map<string, string>()
  private pending = new Map<string, Promise<ModelCatalogSnapshot>>()
  private generation = 0
  private activeKey: string | null = null
  constructor(
    private options: {
      fetch?: typeof fetch
      now?: () => number
      cacheDir?: string
    } = {},
  ) {}

  private key(auth: AuthInfo): string {
    return createHash('sha256')
      .update(auth.accountId ?? auth.access)
      .digest('hex')
  }
  private file(key: string): string {
    return join(
      this.options.cacheDir ?? join(homedir(), '.cache', 'ouroboros', 'models'),
      `${key}.json`,
    )
  }
  clear(): void {
    this.generation++
    this.activeKey = null
    for (const key of this.cache.keys()) {
      try {
        rmSync(this.file(key), { force: true })
      } catch {
        /* best effort */
      }
    }
    this.cache.clear()
    this.errors.clear()
    this.pending.clear()
    setSubscriptionModels([])
  }
  async get(auth?: AuthInfo, refresh = false): Promise<ModelCatalogSnapshot> {
    if (!auth) {
      this.activeKey = null
      setSubscriptionModels([])
      return this.fallback()
    }
    const key = this.key(auth)
    this.activeKey = key
    if (!this.cache.has(key)) {
      try {
        const saved = JSON.parse(readFileSync(this.file(key), 'utf8'))
        if (
          Array.isArray(saved.modelDetails) &&
          typeof saved.catalogFetchedAt === 'string' &&
          Number.isFinite(Date.parse(saved.catalogFetchedAt)) &&
          saved.modelDetails.every(isCachedDescriptor)
        ) {
          this.cache.set(key, {
            modelDetails: saved.modelDetails,
            catalogFetchedAt: saved.catalogFetchedAt,
            catalogSource: 'cache',
          })
        }
      } catch {
        /* missing or corrupt cache is safe to replace */
      }
    }
    const cached = this.cache.get(key)
    const now = this.options.now?.() ?? Date.now()
    if (
      !refresh &&
      cached?.catalogFetchedAt &&
      now - Date.parse(cached.catalogFetchedAt) < CATALOG_TTL_MS
    ) {
      setSubscriptionModels(cached.modelDetails)
      return {
        ...cached,
        catalogSource: 'cache',
        ...(this.errors.has(key) ? { catalogError: this.errors.get(key) } : {}),
      }
    }
    let request = this.pending.get(key)
    if (!request) {
      const generation = this.generation
      request = this.fetchCatalog(auth, now)
        .then((snapshot) => {
          if (generation === this.generation) {
            this.errors.delete(key)
            this.cache.set(key, snapshot)
            try {
              const file = this.file(key)
              mkdirSync(join(file, '..'), { recursive: true })
              writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 })
            } catch {
              /* an unwritable cache must not block inference */
            }
          }
          return snapshot
        })
        .catch(() => {
          const catalogError =
            'Unable to refresh subscription models. Showing unverified saved choices; reconnect or retry.'
          if (generation === this.generation) this.errors.set(key, catalogError)
          return {
            ...(cached ? { ...cached, catalogSource: 'cache' as const } : this.fallback()),
            catalogError,
          }
        })
        .finally(() => {
          if (this.pending.get(key) === request) this.pending.delete(key)
        })
      this.pending.set(key, request)
    }
    const generation = this.generation
    const result = await request
    if (generation === this.generation && this.activeKey === key)
      setSubscriptionModels(result.modelDetails)
    return result
  }
  private fallback(): ModelCatalogSnapshot {
    return { modelDetails: getBundledSubscriptionModels(), catalogSource: 'bundled' }
  }
  private async fetchCatalog(auth: AuthInfo, now: number): Promise<ModelCatalogSnapshot> {
    const response = await (this.options.fetch ?? fetch)(CODEX_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${auth.access}`,
        originator: 'codex_cli_rs',
        'User-Agent': 'ouroboros',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Model catalogue HTTP ${response.status}`)
    const data = (await response.json()) as { models?: unknown }
    if (!Array.isArray(data.models)) throw new Error('Invalid model catalogue')
    const seen = new Set<string>()
    const modelDetails: ModelDescriptor[] = []
    for (const item of data.models) {
      if (
        !item ||
        typeof item !== 'object' ||
        item.visibility !== 'list' ||
        item.supported_in_api === false ||
        typeof item.slug !== 'string' ||
        !item.slug.trim() ||
        typeof item.display_name !== 'string' ||
        seen.has(item.slug)
      )
        continue
      seen.add(item.slug)
      const known = getModelDescriptor(item.slug, 'openai-chatgpt')
      const efforts = Array.isArray(item.supported_reasoning_levels)
        ? REASONING_EFFORTS.filter((e) =>
            item.supported_reasoning_levels.some((r: { effort?: unknown }) => r?.effort === e),
          )
        : (known?.reasoningEfforts ?? (['low', 'medium', 'high'] as const))
      modelDetails.push({
        ...known,
        id: item.slug,
        displayName: item.display_name,
        family: 'openai',
        contextWindowTokens:
          Number.isSafeInteger(item.context_window) && item.context_window > 0
            ? item.context_window
            : (known?.contextWindowTokens ?? 272_000),
        reasoningKind: efforts.length ? 'openai-reasoning' : undefined,
        reasoningEfforts: [...efforts],
        lifecycle: 'current',
        omitSampling: true,
        sourceUrl: CODEX_MODELS_ENDPOINT,
        verifiedAt: new Date(now).toISOString(),
      })
    }
    return { modelDetails, catalogSource: 'live', catalogFetchedAt: new Date(now).toISOString() }
  }
}

export const subscriptionModelCatalog = new SubscriptionModelCatalog()
