import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOG_TTL_MS, SubscriptionModelCatalog } from '@src/auth/model-catalog'
import { isSupportedOpenAIChatGPTModel } from '@src/auth/openai-chatgpt'
import { getContextWindowTokens, setSubscriptionModels } from '@ouroboros/shared'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  setSubscriptionModels([])
})
const auth = (accountId = 'account-a') => ({
  type: 'oauth' as const,
  accountId,
  access: 'secret-token',
  refresh: 'refresh-secret',
  expires: Date.now() + 60_000,
})
const item = (slug = 'gpt-future', visibility = 'list') => ({
  slug,
  display_name: `Display ${slug}`,
  visibility,
  context_window: 350_000,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }],
})
function setup(handler: () => Promise<Response>, now: () => number = Date.now) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ou-model-catalog-'))
  dirs.push(cacheDir)
  return {
    cacheDir,
    catalog: new SubscriptionModelCatalog({
      cacheDir,
      now,
      fetch: handler as unknown as typeof fetch,
    }),
  }
}

describe('subscription catalogue', () => {
  test('preserves server order and future IDs, filters hidden models and orchestration efforts', async () => {
    const { catalog, cacheDir } = setup(async () =>
      Response.json({
        models: [item('gpt-future'), item('internal', 'hide'), item('gpt-6.1-sol')],
      }),
    )
    const result = await catalog.get(auth())
    expect(result.catalogSource).toBe('live')
    expect(result.modelDetails.map((m) => m.id)).toEqual(['gpt-future', 'gpt-6.1-sol'])
    expect(result.modelDetails[0].displayName).toBe('Display gpt-future')
    expect(result.modelDetails[0].reasoningEfforts).toEqual(['low', 'max'])
    expect(getContextWindowTokens('gpt-future', 'openai-chatgpt')).toBe(350_000)
    expect(isSupportedOpenAIChatGPTModel('gpt-future')).toBe(true)
    const saved = readFileSync(join(cacheDir, readdirSync(cacheDir)[0]), 'utf8')
    expect(saved).not.toContain('secret-token')
    expect(saved).not.toContain('account-a')
  })
  test('an explicitly returned model takes precedence over a historical retirement record', async () => {
    expect(isSupportedOpenAIChatGPTModel('gpt-5.5')).toBe(false)
    const { catalog } = setup(async () => Response.json({ models: [item('gpt-5.5')] }))
    await catalog.get(auth())
    expect(isSupportedOpenAIChatGPTModel('gpt-5.5')).toBe(true)
  })
  test('coalesces requests, caches ten minutes, refreshes explicitly and isolates accounts', async () => {
    let calls = 0
    let time = Date.now()
    const { catalog } = setup(
      async () => {
        calls++
        await Promise.resolve()
        return Response.json({ models: [item(`gpt-${calls}`)] })
      },
      () => time,
    )
    await Promise.all([catalog.get(auth()), catalog.get(auth())])
    expect(calls).toBe(1)
    expect((await catalog.get(auth())).catalogSource).toBe('cache')
    time += CATALOG_TTL_MS + 1
    await catalog.get(auth())
    expect(calls).toBe(2)
    await catalog.get(auth(), true)
    expect(calls).toBe(3)
    await catalog.get(auth('account-b'))
    expect(calls).toBe(4)
    catalog.clear()
    expect(getContextWindowTokens('gpt-4', 'openai-chatgpt')).toBeNull()
  })
  test('uses last successful per-account cache on failure, never another account', async () => {
    let fail = false
    const { catalog } = setup(async () => {
      if (fail) return Response.json({}, { status: 403 })
      return Response.json({ models: [item()] })
    })
    await catalog.get(auth())
    fail = true
    const stale = await catalog.get(auth(), true)
    expect(stale.catalogSource).toBe('cache')
    expect(stale.catalogError).toContain('unverified')
    expect(stale.modelDetails[0].id).toBe('gpt-future')
    expect((await catalog.get(auth())).catalogError).toContain('unverified')
    const other = await catalog.get(auth('account-b'))
    expect(other.catalogSource).toBe('bundled')
    expect(other.modelDetails.some((m) => m.id === 'gpt-future')).toBe(false)
    fail = false
    expect((await catalog.get(auth(), true)).catalogError).toBeUndefined()
  })
  test('rejects malformed responses and corrupt disk cache; empty live accounts stay empty', async () => {
    const { catalog, cacheDir } = setup(async () => Response.json({ models: [] }))
    const result = await catalog.get(auth())
    expect(result.modelDetails).toEqual([])
    writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]), 'invalid json')
    const other = new SubscriptionModelCatalog({
      cacheDir,
      fetch: (async () => Response.json({ wrong: [] })) as unknown as typeof fetch,
    })
    expect((await other.get(auth())).catalogSource).toBe('bundled')
    expect((await other.get()).modelDetails.some((m) => m.id.includes('daybreak'))).toBe(false)
  })
  test('logout invalidates a request already in flight', async () => {
    let finish!: () => void
    const { catalog } = setup(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return Response.json({ models: [item()] })
    })
    const request = catalog.get(auth())
    catalog.clear()
    finish()
    await request
    expect(getContextWindowTokens('gpt-future', 'openai-chatgpt')).toBeNull()
  })
  test('an older account request cannot overwrite the active account capabilities', async () => {
    const finish: Array<() => void> = []
    const { catalog } = setup(async () => {
      const index = finish.length
      await new Promise<void>((resolve) => finish.push(resolve))
      return Response.json({ models: [item(`gpt-account-${index}`)] })
    })
    const first = catalog.get(auth('a'))
    const second = catalog.get(auth('b'))
    finish[1]()
    await second
    finish[0]()
    await first
    expect(getContextWindowTokens('gpt-account-1', 'openai-chatgpt')).toBe(350_000)
    expect(getContextWindowTokens('gpt-account-0', 'openai-chatgpt')).toBeNull()
  })
  test('valid disk metadata survives restart and incomplete descriptors are rejected', async () => {
    const { catalog, cacheDir } = setup(async () => Response.json({ models: [item()] }))
    await catalog.get(auth())
    const offline = () =>
      new SubscriptionModelCatalog({
        cacheDir,
        fetch: (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch,
      })
    expect((await offline().get(auth())).catalogSource).toBe('cache')
    const file = join(cacheDir, readdirSync(cacheDir)[0])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    delete saved.modelDetails[0].sourceUrl
    writeFileSync(file, JSON.stringify(saved))
    expect((await offline().get(auth())).catalogSource).toBe('bundled')
  })
})
