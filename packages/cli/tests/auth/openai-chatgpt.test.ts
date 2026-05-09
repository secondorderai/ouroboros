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

  test('isSupportedOpenAIChatGPTModel accepts gpt-5.5 family', () => {
    expect(isSupportedOpenAIChatGPTModel('gpt-5.5')).toBe(true)
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
})
