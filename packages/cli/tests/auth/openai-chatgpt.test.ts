import { getBundledSubscriptionModels } from '@ouroboros/shared'
import { configSchema } from '@src/config'
import { subscriptionModelCatalog } from '@src/auth/model-catalog'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let mockedHomedir: string | undefined
mock.module('node:os', () => {
  const real = require('node:os')
  return {
    ...real,
    homedir: () => mockedHomedir ?? real.homedir(),
  }
})

import { getAuthFilePath, removeAuth, setAuth } from '@src/auth'
import {
  buildAuthorizeUrl,
  createOpenAIChatGPTFetch,
  ensureOpenAIChatGPTAuth,
  extractAccountIdFromClaims,
  isSupportedOpenAIChatGPTModel,
  OPENAI_CHATGPT_PROVIDER,
  OpenAIChatGPTAuthManager,
  parseJwtClaims,
} from '@src/auth/openai-chatgpt'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ouroboros-auth-test-'))
}

function createTypedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const wrapped = handler as unknown as typeof fetch
  wrapped.preconnect = fetch.preconnect.bind(fetch)
  return wrapped
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

describe('openai-chatgpt auth', () => {
  const originalFetch = globalThis.fetch
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
    mockedHomedir = tempDir
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    mockedHomedir = undefined
    globalThis.fetch = originalFetch
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('auth store persists oauth records with 0600 permissions', () => {
    const result = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
      accountId: 'acct_test',
    })

    expect(result.ok).toBe(true)

    const authPath = getAuthFilePath()
    const mode = statSync(authPath).mode & 0o777
    expect(mode).toBe(0o600)

    const raw = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>
    expect((raw.auth as Record<string, unknown>)[OPENAI_CHATGPT_PROVIDER]).toBeDefined()
  })

  test('parseJwtClaims and extractAccountIdFromClaims support ChatGPT account claims', () => {
    const token = createJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_claim',
      },
    })

    const claims = parseJwtClaims(token)
    expect(claims).toBeDefined()
    expect(claims && extractAccountIdFromClaims(claims)).toBe('acct_claim')
  })

  test('ensureOpenAIChatGPTAuth refreshes expired tokens and persists updated auth', async () => {
    const refreshToken = 'refresh-token'
    const refreshedAccessToken = createJwt({
      chatgpt_account_id: 'acct_refresh',
    })

    const saveResult = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: refreshToken,
      access: 'expired-access-token',
      expires: Date.now() - 1_000,
    })
    expect(saveResult.ok).toBe(true)

    globalThis.fetch = createTypedFetch(async (_input, init) => {
      expect(init?.method).toBe('POST')
      return new Response(
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'refresh-token-next',
          expires_in: 3600,
          id_token: createJwt({ chatgpt_account_id: 'acct_refresh' }),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    })

    const authResult = await ensureOpenAIChatGPTAuth()
    expect(authResult.ok).toBe(true)
    if (!authResult.ok) return

    expect(authResult.value.access).toBe(refreshedAccessToken)
    expect(authResult.value.refresh).toBe('refresh-token-next')
    expect(authResult.value.accountId).toBe('acct_refresh')

    const storedConfig = JSON.parse(readFileSync(getAuthFilePath(), 'utf8')) as {
      auth: Record<string, { access: string; refresh: string; accountId?: string }>
    }
    expect(storedConfig.auth[OPENAI_CHATGPT_PROVIDER]).toEqual(
      expect.objectContaining({
        access: refreshedAccessToken,
        refresh: 'refresh-token-next',
        accountId: 'acct_refresh',
      }),
    )
  })

  test('a rejected refresh gives installed CLI users a usable reconnect command', async () => {
    expect(
      setAuth(OPENAI_CHATGPT_PROVIDER, {
        type: 'oauth',
        refresh: 'revoked-refresh-token',
        access: 'expired-access-token',
        expires: Date.now() - 1_000,
      }).ok,
    ).toBe(true)
    globalThis.fetch = createTypedFetch(async () => new Response(null, { status: 401 }))

    const result = await ensureOpenAIChatGPTAuth()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('ChatGPT subscription login expired')
    expect(result.error.message).toContain('ouroboros auth login --provider openai-chatgpt')
    expect(result.error.message).not.toContain('bun run dev')
    expect(result.error.message).not.toContain('API key')
  })

  test('createOpenAIChatGPTFetch rewrites requests and injects subscription auth headers', async () => {
    const saveResult = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'live-access-token',
      expires: Date.now() + 60_000,
      accountId: 'acct_header',
    })
    expect(saveResult.ok).toBe(true)

    let capturedRequest: Request | null = null
    const fetchWithAuth = createOpenAIChatGPTFetch(
      createTypedFetch(async (input, init) => {
        capturedRequest = new Request(input, init)
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )

    await fetchWithAuth('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer should-be-replaced',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-5.4' }),
    })

    expect(capturedRequest).not.toBeNull()
    const request = capturedRequest as unknown as Request

    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request.headers.get('Authorization')).toBe('Bearer live-access-token')
    expect(request.headers.get('ChatGPT-Account-Id')).toBe('acct_header')
    expect(request.headers.get('originator')).toBe('codex_cli_rs')
  })

  test('removeAuth clears stored provider credentials', () => {
    const saveResult = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
    })
    expect(saveResult.ok).toBe(true)

    const removeResult = removeAuth(OPENAI_CHATGPT_PROVIDER)
    expect(removeResult.ok).toBe(true)

    const raw = JSON.parse(readFileSync(getAuthFilePath(), 'utf8')) as {
      auth?: Record<string, unknown>
    }
    expect(raw.auth?.[OPENAI_CHATGPT_PROVIDER]).toBeUndefined()
  })

  test('browser login uses official Codex authorize parameters', () => {
    const url = new URL(
      buildAuthorizeUrl(
        'http://localhost:1455/auth/callback',
        {
          verifier: 'verifier',
          challenge: 'challenge',
        },
        'state',
      ),
    )
    expect(url.hostname).toBe('auth.openai.com')
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs')
    expect(url.searchParams.get('scope')).toBe(
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    )
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
  })

  test('subscription models include GPT-6 and reject retired GPT-5.5', () => {
    expect(isSupportedOpenAIChatGPTModel('gpt-5.5')).toBe(false)
    expect(isSupportedOpenAIChatGPTModel('gpt-6.1-sol')).toBe(true)
  })

  test('setAuth preserves existing ~/.ouroboros runtime config', () => {
    const configFilePath = join(tempDir, '.ouroboros')
    writeFileSync(configFilePath, '{"model":{"provider":"anthropic","name":"claude"}}', 'utf-8')

    const result = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
    })

    expect(result.ok).toBe(true)
    expect(statSync(configFilePath).isFile()).toBe(true)
    const raw = JSON.parse(readFileSync(configFilePath, 'utf-8')) as {
      model?: { provider?: string; name?: string }
      auth?: Record<string, unknown>
    }
    expect(raw.model).toEqual({ provider: 'anthropic', name: 'claude' })
    expect(raw.auth?.[OPENAI_CHATGPT_PROVIDER]).toBeDefined()
  })

  test('legacy .ouroboros-auth.json is ignored after hard cutover', async () => {
    writeFileSync(
      join(tempDir, '.ouroboros-auth.json'),
      JSON.stringify({
        [OPENAI_CHATGPT_PROVIDER]: {
          type: 'oauth',
          refresh: 'legacy-refresh',
          access: 'legacy-access',
          expires: Date.now() + 60_000,
        },
      }),
      'utf-8',
    )

    const authResult = await ensureOpenAIChatGPTAuth()

    expect(getAuthFilePath()).toBe(join(tempDir, '.ouroboros'))
    expect(authResult.ok).toBe(false)
  })
  test('repairs only retired saved subscription selections and preserves API models and explicit overrides', async () => {
    const manager = new OpenAIChatGPTAuthManager()
    manager.getStatus = async () => ({
      provider: 'openai-chatgpt',
      connected: true,
      authType: 'oauth',
      pending: false,
      availableMethods: ['browser', 'headless'],
      models: ['gpt-6.1-sol', 'gpt-6-luna'],
      modelDetails: getBundledSubscriptionModels().filter((m) =>
        ['gpt-6.1-sol', 'gpt-6-luna'].includes(m.id),
      ),
      catalogSource: 'live',
    })
    const config = configSchema.parse({ model: { provider: 'openai-chatgpt', name: 'gpt-5.5' } })
    const result = await manager.resolveModel(config, tempDir)
    expect(result.ok && result.value.model.name).toBe('gpt-6.1-sol')
    expect(result.ok && result.value.memory.contextWindowTokens).toBe(500_000)
    expect(JSON.parse(readFileSync(join(tempDir, '.ouroboros'), 'utf8')).model.name).toBe(
      'gpt-6.1-sol',
    )
    const mini = await manager.resolveModel(
      { ...config, model: { ...config.model, name: 'gpt-5.4-mini' } },
      tempDir,
    )
    expect(mini.ok && mini.value.model.name).toBe('gpt-6-luna')
    const overridden = await manager.resolveModel(
      {
        ...config,
        memory: { ...config.memory, contextWindowTokens: 40_000, contextWindowSource: 'config' },
      },
      tempDir,
    )
    expect(overridden.ok && overridden.value.memory.contextWindowTokens).toBe(40_000)
    expect((await manager.resolveModel(config, tempDir, true)).ok).toBe(false)
    const api = await manager.resolveModel(
      { ...config, model: { ...config.model, provider: 'openai' } },
      tempDir,
    )
    expect(api.ok && api.value.model.name).toBe('gpt-5.5')
    const custom = await manager.resolveModel(
      {
        ...config,
        model: {
          ...config.model,
          provider: 'openai-compatible',
          baseUrl: 'https://example.invalid/v1',
        },
      },
      tempDir,
    )
    expect(custom.ok && custom.value.model.name).toBe('gpt-5.5')
    const explicitUnavailable = await manager.resolveModel(
      { ...config, model: { ...config.model, name: 'gpt-6-astra' } },
      tempDir,
      true,
    )
    expect(explicitUnavailable.ok).toBe(false)
  })

  test('status includes account catalogue descriptors and honours refresh; logout clears capabilities', async () => {
    subscriptionModelCatalog.clear()
    setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      access: 'test-access',
      refresh: 'test-refresh',
      expires: Date.now() + 60_000,
      accountId: 'test-refresh-account',
    })
    let calls = 0
    globalThis.fetch = createTypedFetch(async () => {
      calls++
      return Response.json({
        models: [
          {
            slug: 'gpt-future-model',
            display_name: 'Future Model',
            visibility: 'list',
            context_window: 123_000,
            supported_reasoning_levels: [{ effort: 'high' }],
          },
        ],
      })
    })
    const manager = new OpenAIChatGPTAuthManager()
    const first = await manager.getStatus()
    expect(first.models).toEqual(['gpt-future-model'])
    expect(first.modelDetails[0].displayName).toBe('Future Model')
    expect(isSupportedOpenAIChatGPTModel('gpt-future-model')).toBe(true)
    await manager.getStatus()
    expect(calls).toBe(1)
    await manager.getStatus(true)
    expect(calls).toBe(2)
    expect((await manager.logout()).ok).toBe(true)
    expect(isSupportedOpenAIChatGPTModel('gpt-future-model')).toBe(false)
  })
  test('a failed reconnect retains the account last successful catalogue', async () => {
    subscriptionModelCatalog.clear()
    setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      access: 'test-access',
      refresh: 'test-refresh',
      expires: Date.now() + 60_000,
      accountId: 'reconnect-account',
    })
    globalThis.fetch = createTypedFetch(async () =>
      Response.json({
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'GPT-6.1 Sol',
            visibility: 'list',
            context_window: 500_000,
          },
        ],
      }),
    )
    const manager = new OpenAIChatGPTAuthManager()
    expect((await manager.getStatus()).catalogSource).toBe('live')
    globalThis.fetch = createTypedFetch(async () => Response.json({}, { status: 503 }))
    expect((await manager.startLogin('headless')).ok).toBe(false)
    const status = await manager.getStatus(true)
    expect(status.catalogSource).toBe('cache')
    expect(status.models).toEqual(['gpt-6.1-sol'])
    expect(status.catalogError).toContain('unverified')
    await manager.logout()
  })
})
