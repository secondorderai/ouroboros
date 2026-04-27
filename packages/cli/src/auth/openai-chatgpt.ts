import { err, ok, type Result } from '@src/types'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAuth, isAuthExpired, removeAuth, setAuth, type AuthInfo } from './index'

export const OPENAI_CHATGPT_PROVIDER = 'openai-chatgpt'
export const OPENAI_CHATGPT_AUTH_METHODS = ['browser', 'headless'] as const
export type OpenAIChatGPTAuthMethod = (typeof OPENAI_CHATGPT_AUTH_METHODS)[number]

export const OPENAI_CHATGPT_SUPPORTED_MODELS = [
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.5-mini',
  'gpt-5.5-codex',
] as const

export const OPENAI_CHATGPT_OAUTH_DUMMY_KEY = 'ouroboros-oauth-dummy-key'

const ISSUER = 'https://auth.openai.com'
const OAUTH_TOKEN_ENDPOINT = `${ISSUER}/oauth/token`
const DEVICE_CODE_ENDPOINT = `${ISSUER}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_ENDPOINT = `${ISSUER}/api/accounts/deviceauth/token`
const DEVICE_AUTH_URL = `${ISSUER}/codex/device`
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CALLBACK_PUBLIC_HOST = 'localhost'
const CALLBACK_BIND_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const POLLING_MARGIN_MS = 3000
const CODEX_ORIGINATOR = 'codex_cli_rs'
const AUTHORIZE_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

export interface OpenAIChatGPTStatus {
  provider: typeof OPENAI_CHATGPT_PROVIDER
  connected: boolean
  authType: 'oauth' | null
  pending: boolean
  accountId?: string
  availableMethods: OpenAIChatGPTAuthMethod[]
  models: string[]
}

export interface OpenAIChatGPTStartLoginResult {
  flowId: string
  provider: typeof OPENAI_CHATGPT_PROVIDER
  method: OpenAIChatGPTAuthMethod
  url: string
  instructions: string
  pending: true
}

export interface OpenAIChatGPTPollResult extends OpenAIChatGPTStatus {
  flowId: string
  method: OpenAIChatGPTAuthMethod
  success: boolean
  error?: string
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface DeviceCodeResponse {
  device_auth_id: string
  user_code: string
  interval: string
}

interface DeviceTokenResponse {
  authorization_code: string
  code_verifier: string
}

interface PkceCodes {
  verifier: string
  challenge: string
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

type FlowStatus = 'pending' | 'success' | 'error' | 'cancelled'

interface FlowRecord {
  id: string
  method: OpenAIChatGPTAuthMethod
  url: string
  instructions: string
  status: FlowStatus
  error?: string
  accountId?: string
  abortController: AbortController
  server?: Server
}

export function isSupportedOpenAIChatGPTModel(model: string): boolean {
  return OPENAI_CHATGPT_SUPPORTED_MODELS.includes(
    model as (typeof OPENAI_CHATGPT_SUPPORTED_MODELS)[number],
  )
}

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join('')
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as IdTokenClaims
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }

  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }

  return undefined
}

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: AUTHORIZE_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: CODEX_ORIGINATOR,
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  return (await response.json()) as TokenResponse
}

export async function refreshOpenAIChatGPTAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }

  return (await response.json()) as TokenResponse
}

async function probeOpenAIChatGPTAuth(accessToken: string, accountId?: string): Promise<void> {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    originator: CODEX_ORIGINATOR,
    'User-Agent': `ouroboros/${process.platform}-${process.arch}`,
  })
  if (accountId) {
    headers.set('ChatGPT-Account-Id', accountId)
  }

  const response = await fetch(CODEX_API_ENDPOINT, {
    method: 'OPTIONS',
    headers,
    signal: AbortSignal.timeout(10000),
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenAI ChatGPT authentication was rejected')
  }
}

export async function ensureOpenAIChatGPTAuth(configDir?: string): Promise<Result<AuthInfo>> {
  const authResult = getAuth(OPENAI_CHATGPT_PROVIDER, configDir)
  if (!authResult.ok) {
    return authResult
  }

  const auth = authResult.value
  if (!auth || auth.type !== 'oauth') {
    return err(
      new Error(
        'Missing ChatGPT subscription login. Run `ouroboros auth login --provider openai-chatgpt` first.',
      ),
    )
  }

  if (!isAuthExpired(auth)) {
    return ok(auth)
  }

  try {
    const tokens = await refreshOpenAIChatGPTAccessToken(auth.refresh)
    const nextAuth: AuthInfo = {
      type: 'oauth',
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(tokens) ?? auth.accountId,
    }
    const saveResult = setAuth(OPENAI_CHATGPT_PROVIDER, nextAuth, configDir)
    if (!saveResult.ok) {
      return saveResult
    }
    return ok(nextAuth)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to refresh ChatGPT subscription token: ${message}`))
  }
}

function removeAuthorizationHeader(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers)
  headers.delete('authorization')
  headers.delete('Authorization')
  return headers
}

export function createOpenAIChatGPTFetch(
  baseFetch: typeof fetch = fetch,
  configDir?: string,
): typeof fetch {
  const authFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    const authResult = await ensureOpenAIChatGPTAuth(configDir)
    if (!authResult.ok) {
      throw authResult.error
    }

    const headers = removeAuthorizationHeader(init)
    headers.set('Authorization', `Bearer ${authResult.value.access}`)
    headers.set('originator', CODEX_ORIGINATOR)
    headers.set('User-Agent', `ouroboros/${process.platform}-${process.arch}`)

    if (authResult.value.accountId) {
      headers.set('ChatGPT-Account-Id', authResult.value.accountId)
    }

    return baseFetch(CODEX_API_ENDPOINT, {
      ...init,
      headers,
    })
  }

  const typedFetch = authFetch as unknown as typeof fetch
  typedFetch.preconnect = baseFetch.preconnect.bind(baseFetch)
  return typedFetch
}

async function openExternalUrl(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? { name: 'open', args: [url] }
      : process.platform === 'win32'
        ? { name: 'cmd', args: ['/c', 'start', '', url] }
        : { name: 'xdg-open', args: [url] }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.name, command.args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Ouroboros Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #101214;
        color: #f5f7fa;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      p {
        color: #c5ced9;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Ouroboros.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (message: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Ouroboros Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #101214;
        color: #f5f7fa;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p class="error">${message}</p>
    </div>
  </body>
</html>`

export class OpenAIChatGPTAuthManager {
  private activeFlow: FlowRecord | null = null

  async getStatus(): Promise<OpenAIChatGPTStatus> {
    const authResult = getAuth(OPENAI_CHATGPT_PROVIDER)
    const auth = authResult.ok ? authResult.value : undefined

    return {
      provider: OPENAI_CHATGPT_PROVIDER,
      connected: Boolean(auth?.type === 'oauth'),
      authType: auth?.type ?? null,
      pending: this.activeFlow?.status === 'pending',
      accountId: auth?.accountId,
      availableMethods: [...OPENAI_CHATGPT_AUTH_METHODS],
      models: [...OPENAI_CHATGPT_SUPPORTED_MODELS],
    }
  }

  async startLogin(
    method: OpenAIChatGPTAuthMethod,
  ): Promise<Result<OpenAIChatGPTStartLoginResult>> {
    if (this.activeFlow?.status === 'pending') {
      this.cancelFlow(this.activeFlow, 'Cancelled previous login attempt')
    }

    return method === 'browser' ? this.startBrowserLogin() : this.startHeadlessLogin()
  }

  async pollLogin(flowId: string): Promise<Result<OpenAIChatGPTPollResult>> {
    const flow = this.activeFlow
    if (!flow || flow.id !== flowId) {
      return err(new Error('Auth flow not found'))
    }

    const status = await this.getStatus()
    return ok({
      ...status,
      flowId: flow.id,
      method: flow.method,
      success: flow.status === 'success',
      pending: flow.status === 'pending',
      error: flow.error,
      accountId: flow.accountId ?? status.accountId,
    })
  }

  async cancelLogin(flowId: string): Promise<Result<{ cancelled: boolean }>> {
    const flow = this.activeFlow
    if (!flow || flow.id !== flowId) {
      return ok({ cancelled: false })
    }

    this.cancelFlow(flow, 'Login cancelled')
    return ok({ cancelled: true })
  }

  async logout(): Promise<Result<void>> {
    if (this.activeFlow?.status === 'pending') {
      this.cancelFlow(this.activeFlow, 'Login cancelled')
    }
    return removeAuth(OPENAI_CHATGPT_PROVIDER)
  }

  async openStartedFlow(flow: OpenAIChatGPTStartLoginResult): Promise<Result<void>> {
    try {
      await openExternalUrl(flow.url)
      return ok(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return err(new Error(`Failed to open browser: ${message}`))
    }
  }

  async waitForCompletion(flowId: string): Promise<Result<OpenAIChatGPTPollResult>> {
    while (true) {
      const pollResult = await this.pollLogin(flowId)
      if (!pollResult.ok) return pollResult
      if (!pollResult.value.pending) return pollResult
      await sleep(1000)
    }
  }

  async testConnection(): Promise<Result<{ models: string[]; accountId?: string }>> {
    const authResult = await ensureOpenAIChatGPTAuth()
    if (!authResult.ok) {
      return authResult
    }

    try {
      await probeOpenAIChatGPTAuth(authResult.value.access, authResult.value.accountId)
      return ok({
        models: [...OPENAI_CHATGPT_SUPPORTED_MODELS],
        accountId: authResult.value.accountId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return err(new Error(`ChatGPT subscription probe failed: ${message}`))
    }
  }

  private async startBrowserLogin(): Promise<Result<OpenAIChatGPTStartLoginResult>> {
    const flowId = randomUUID()
    const abortController = new AbortController()
    const pkce = await generatePKCE()
    const state = generateState()
    const redirectUri = `http://${CALLBACK_PUBLIC_HOST}:${CALLBACK_PORT}/auth/callback`
    const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

    const flow: FlowRecord = {
      id: flowId,
      method: 'browser',
      url: authUrl,
      instructions: 'Complete authorization in your browser. This window will close automatically.',
      status: 'pending',
      abortController,
    }
    this.activeFlow = flow

    const serverResult = await this.startCallbackServer(flow, pkce, state)
    if (!serverResult.ok) {
      this.activeFlow = null
      return serverResult
    }

    flow.server = serverResult.value

    return ok({
      flowId,
      provider: OPENAI_CHATGPT_PROVIDER,
      method: 'browser',
      url: authUrl,
      instructions: flow.instructions,
      pending: true,
    })
  }

  private async startHeadlessLogin(): Promise<Result<OpenAIChatGPTStartLoginResult>> {
    const flowId = randomUUID()
    const abortController = new AbortController()

    try {
      const response = await fetch(DEVICE_CODE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `ouroboros/${process.platform}-${process.arch}`,
        },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      })

      if (!response.ok) {
        return err(new Error(`Failed to start device authorization: ${response.status}`))
      }

      const deviceData = (await response.json()) as DeviceCodeResponse
      const intervalMs =
        Math.max(parseInt(deviceData.interval, 10) || 5, 1) * 1000 + POLLING_MARGIN_MS

      const flow: FlowRecord = {
        id: flowId,
        method: 'headless',
        url: DEVICE_AUTH_URL,
        instructions: `Enter code: ${deviceData.user_code}`,
        status: 'pending',
        abortController,
      }
      this.activeFlow = flow

      void this.pollHeadlessLogin(flow, deviceData, intervalMs)

      return ok({
        flowId,
        provider: OPENAI_CHATGPT_PROVIDER,
        method: 'headless',
        url: flow.url,
        instructions: flow.instructions,
        pending: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return err(new Error(`Failed to start device authorization: ${message}`))
    }
  }

  private async startCallbackServer(
    flow: FlowRecord,
    pkce: PkceCodes,
    state: string,
  ): Promise<Result<Server>> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${CALLBACK_PUBLIC_HOST}:${CALLBACK_PORT}`)

      if (url.pathname !== '/auth/callback') {
        response.writeHead(404)
        response.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const oauthError = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (oauthError) {
        const message = errorDescription || oauthError
        this.failFlow(flow, message)
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(HTML_ERROR(message))
        return
      }

      if (!code) {
        this.failFlow(flow, 'Missing authorization code')
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(HTML_ERROR('Missing authorization code'))
        return
      }

      if (returnedState !== state) {
        this.failFlow(flow, 'Invalid state')
        response.writeHead(400, { 'Content-Type': 'text/html' })
        response.end(HTML_ERROR('Invalid state'))
        return
      }

      void exchangeCodeForTokens(
        code,
        `http://${CALLBACK_PUBLIC_HOST}:${CALLBACK_PORT}/auth/callback`,
        pkce,
      )
        .then((tokens) => this.completeFlow(flow, tokens))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.failFlow(flow, message)
        })

      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(HTML_SUCCESS)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(CALLBACK_PORT, CALLBACK_BIND_HOST, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      return ok(server)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return err(new Error(`Failed to start OAuth callback server: ${message}`))
    }
  }

  private async pollHeadlessLogin(
    flow: FlowRecord,
    deviceData: DeviceCodeResponse,
    intervalMs: number,
  ): Promise<void> {
    while (flow.status === 'pending' && !flow.abortController.signal.aborted) {
      try {
        const response = await fetch(DEVICE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `ouroboros/${process.platform}-${process.arch}`,
          },
          body: JSON.stringify({
            device_auth_id: deviceData.device_auth_id,
            user_code: deviceData.user_code,
          }),
          signal: flow.abortController.signal,
        })

        if (response.ok) {
          const deviceToken = (await response.json()) as DeviceTokenResponse
          const tokenResponse = await fetch(OAUTH_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: deviceToken.authorization_code,
              redirect_uri: `${ISSUER}/deviceauth/callback`,
              client_id: CLIENT_ID,
              code_verifier: deviceToken.code_verifier,
            }).toString(),
            signal: flow.abortController.signal,
          })

          if (!tokenResponse.ok) {
            this.failFlow(flow, `Token exchange failed: ${tokenResponse.status}`)
            return
          }

          const tokens = (await tokenResponse.json()) as TokenResponse
          this.completeFlow(flow, tokens)
          return
        }

        if (response.status !== 403 && response.status !== 404) {
          this.failFlow(flow, `Device authorization failed: ${response.status}`)
          return
        }

        await sleep(intervalMs, undefined, { signal: flow.abortController.signal })
      } catch (error) {
        if (flow.abortController.signal.aborted) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.failFlow(flow, message)
        return
      }
    }
  }

  private async completeFlow(flow: FlowRecord, tokens: TokenResponse): Promise<void> {
    const authInfo: AuthInfo = {
      type: 'oauth',
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(tokens),
    }

    const saveResult = setAuth(OPENAI_CHATGPT_PROVIDER, authInfo)
    if (!saveResult.ok) {
      this.failFlow(flow, saveResult.error.message)
      return
    }

    flow.status = 'success'
    flow.accountId = authInfo.accountId
    this.closeFlowServer(flow)
  }

  private failFlow(flow: FlowRecord, message: string): void {
    flow.status = 'error'
    flow.error = message
    flow.abortController.abort()
    this.closeFlowServer(flow)
  }

  private cancelFlow(flow: FlowRecord, message: string): void {
    flow.status = 'cancelled'
    flow.error = message
    flow.abortController.abort()
    this.closeFlowServer(flow)
  }

  private closeFlowServer(flow: FlowRecord): void {
    if (flow.server) {
      flow.server.close()
      delete flow.server
    }
  }
}
