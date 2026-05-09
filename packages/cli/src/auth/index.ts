import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { readOuroborosFile, writeOuroborosFile } from '@src/config'
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
// belong to the human, so one login should work across every workspace. Auth
// is embedded under the private top-level `auth` key in ~/.ouroboros.
export function getAuthFilePath(): string {
  return join(homedir(), '.ouroboros')
}

function getAuthDir(): string {
  return homedir()
}

function loadAuthStore(): Result<AuthStore> {
  const fileResult = readOuroborosFile(getAuthDir())
  if (!fileResult.ok) {
    return err(new Error(`Failed to read auth store: ${fileResult.error.message}`))
  }

  const auth = fileResult.value.auth
  if (auth === undefined) {
    return ok({})
  }

  const result = authStoreSchema.safeParse(auth)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    return err(new Error(`Invalid auth store: ${issues}`))
  }
  return ok(result.data)
}

function saveAuthStore(store: AuthStore): Result<void> {
  const dir = getAuthDir()
  const fileResult = readOuroborosFile(dir)
  if (!fileResult.ok) {
    return err(new Error(`Failed to read auth store: ${fileResult.error.message}`))
  }

  const writeResult = writeOuroborosFile(dir, {
    ...fileResult.value,
    auth: store,
  })
  if (!writeResult.ok) {
    return err(new Error(`Failed to write auth store: ${writeResult.error.message}`))
  }

  try {
    chmodSync(getAuthFilePath(), 0o600)
  } catch {
    // Best-effort hardening; write failures are already reported above.
  }

  return ok(undefined)
}

export function listAuth(): Result<Record<string, AuthInfo>> {
  return loadAuthStore()
}

export function getAuth(provider: string, _configDir?: string): Result<AuthInfo | undefined> {
  const storeResult = loadAuthStore()
  if (!storeResult.ok) {
    return storeResult
  }

  return ok(storeResult.value[provider])
}

export function setAuth(provider: string, info: AuthInfo, _configDir?: string): Result<void> {
  const storeResult = loadAuthStore()
  if (!storeResult.ok) {
    return storeResult
  }

  return saveAuthStore({
    ...storeResult.value,
    [provider]: info,
  })
}

export function removeAuth(provider: string, _configDir?: string): Result<void> {
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
