import type { UpdateMode } from '../shared/protocol'

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface LaunchUpdatePolicyInput {
  mode: UpdateMode
  platform: NodeJS.Platform
  isPackaged: boolean
  disabledByEnv: boolean
  lastUpdateCheck: number
  now: number
}

export function shouldRunRealUpdater(input: {
  platform: NodeJS.Platform
  isPackaged: boolean
  disabledByEnv: boolean
}): boolean {
  return input.platform === 'darwin' && input.isPackaged && !input.disabledByEnv
}

export function shouldCheckForUpdatesOnLaunch(input: LaunchUpdatePolicyInput): boolean {
  if (!shouldRunRealUpdater(input)) return false
  if (input.mode !== 'auto') return false
  return input.now - input.lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS
}

export function normalizeUpdateMode(value: unknown): UpdateMode {
  return value === 'manual' || value === 'off' ? value : 'auto'
}
