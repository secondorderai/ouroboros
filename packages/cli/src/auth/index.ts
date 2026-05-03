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

// Auth is per-user, not per-project: subscription tokens (e.g. ChatGPT OAuth)
// belong to the human, so we want a single login that works across every
// workspace. `OUROBOROS_AUTH_FILE` overrides for tests; `configDir` is honored
// only when explicitly passed (legacy/test isolation), otherwise we fall back
// to `<homedir>/.ouroboros-auth.json`. Homedir is resolved at call time so
// tests can override `HOME`.
export function getAuthFilePath(configDir?: string): string {
  if (process.env.OUROBOROS_AUTH_FILE) return process.env.OUROBOROS_AUTH_FILE
  if (configDir) return join(configDir, '.ouroboros-auth.json')
  return join(homedir(), '.ouroboros-auth.json')
}

function loadAuthStore(configDir?: string): Result<AuthStore> {
  const authPath = getAuthFilePath(configDir)

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

function saveAuthStore(store: AuthStore, configDir?: string): Result<void> {
  const authPath = getAuthFilePath(configDir)
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

export function listAuth(configDir?: string): Result<Record<string, AuthInfo>> {
  return loadAuthStore(configDir)
}

export function getAuth(provider: string, configDir?: string): Result<AuthInfo | undefined> {
  const storeResult = loadAuthStore(configDir)
  if (!storeResult.ok) {
    return storeResult
  }

  return ok(storeResult.value[provider])
}

export function setAuth(provider: string, info: AuthInfo, configDir?: string): Result<void> {
  const storeResult = loadAuthStore(configDir)
  if (!storeResult.ok) {
    return storeResult
  }

  return saveAuthStore(
    {
      ...storeResult.value,
      [provider]: info,
    },
    configDir,
  )
}

export function removeAuth(provider: string, configDir?: string): Result<void> {
  const storeResult = loadAuthStore(configDir)
  if (!storeResult.ok) {
    return storeResult
  }

  const nextStore = { ...storeResult.value }
  delete nextStore[provider]
  return saveAuthStore(nextStore, configDir)
}

export function isAuthExpired(auth: Pick<AuthInfo, 'expires'>, now = Date.now()): boolean {
  return auth.expires <= now
}
