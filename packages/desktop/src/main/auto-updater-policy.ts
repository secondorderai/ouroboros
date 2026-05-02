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

export function formatUpdaterErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('releases.atom') && message.includes('404')) {
    return [
      'Could not access GitHub release metadata.',
      'The update repository is private or unreachable from the installed app.',
      'Use a public update feed, make the release source public, or provide authenticated update access.',
    ].join(' ')
  }

  if (message.includes('latest-mac.yml') && message.includes('404')) {
    return [
      'Could not find macOS update metadata.',
      'Confirm the latest release includes latest-mac.yml and the macOS zip artifact.',
    ].join(' ')
  }

  return message.split('\n')[0] || 'Could not check for updates.'
}
