import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { type Result, ok, err } from '@src/types'

const oauthAuthSchema = z.object({
  type: z.literal('oauth'),
  refresh: z.string().min(1),
  access: z.string().min(1),
  expires: z.number().int().positive(),
  accountId: z.string().min(1).optional(),
})

export const authInfoSchema = oauthAuthSchema
export type AuthInfo = z.infer<typeof authInfoSchema>

const authStoreSchema = z.record(z.string(), authInfoSchema)
type AuthStore = z.infer<typeof authStoreSchema>

// `.ouroboros` itself is the runtime config file (see packages/cli/src/config.ts),
// so the auth store lives as a sibling file alongside it — matching the existing
// `.ouroboros-transcripts.db` / `.ouroboros_history` pattern.
const DEFAULT_AUTH_FILE = join(homedir(), '.ouroboros-auth.json')

export function getAuthFilePath(): string {
  return process.env.OUROBOROS_AUTH_FILE ?? DEFAULT_AUTH_FILE
}

function loadAuthStore(): Result<AuthStore> {
  const authPath = getAuthFilePath()

  if (!existsSync(authPath)) {
    return ok({})
  }

  try {
    const raw = readFileSync(authPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const result = authStoreSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      return err(new Error(`Invalid auth store: ${issues}`))
    }
    return ok(result.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to read auth store: ${message}`))
  }
}

function saveAuthStore(store: AuthStore): Result<void> {
  const authPath = getAuthFilePath()
  const authDir = dirname(authPath)

  try {
    mkdirSync(authDir, { recursive: true, mode: 0o700 })
    writeFileSync(authPath, JSON.stringify(store, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    })
    chmodSync(authPath, 0o600)
    return ok(undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to write auth store: ${message}`))
  }
}

export function listAuth(): Result<Record<string, AuthInfo>> {
  return loadAuthStore()
}

export function getAuth(provider: string): Result<AuthInfo | undefined> {
  const storeResult = loadAuthStore()
  if (!storeResult.ok) {
    return storeResult
  }

  return ok(storeResult.value[provider])
}

export function setAuth(provider: string, info: AuthInfo): Result<void> {
  const storeResult = loadAuthStore()
  if (!storeResult.ok) {
    return storeResult
  }

  return saveAuthStore({
    ...storeResult.value,
    [provider]: info,
  })
}

export function removeAuth(provider: string): Result<void> {
  const storeResult = loadAuthStore()
  if (!storeResult.ok) {
    return storeResult
  }

  const nextStore = { ...storeResult.value }
  delete nextStore[provider]
  return saveAuthStore(nextStore)
}

export function isAuthExpired(auth: Pick<AuthInfo, 'expires'>, now = Date.now()): boolean {
  return auth.expires <= now
}
