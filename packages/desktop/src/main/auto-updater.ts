/**
 * Auto-updater wrapper around electron-updater.
 *
 * - Checks for updates on app launch, at most once every 24 hours.
 * - Downloads updates in the background.
 * - Emits IPC events to the renderer so the UI can show an update banner.
 * - "Restart to apply" triggers autoUpdater.quitAndInstall().
 */

import pkg from 'electron-updater'
const { autoUpdater } = pkg
type UpdateInfo = pkg.UpdateInfo
import { app, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UpdateCheckResult, UpdatePreferences, UpdateStatus } from '../shared/protocol'
import { recordInstallUpdateRequest } from './ipc-handlers'
import {
  normalizeUpdateMode,
  shouldCheckForUpdatesOnLaunch,
  shouldRunRealUpdater,
} from './auto-updater-policy'
import { TEST_INSTALL_UPDATE_LOG_PATH, TEST_UPDATE_DOWNLOADED_PATH } from './test-paths'

interface UpdateStoreSchema {
  lastUpdateCheck: number
  mode: UpdatePreferences['mode']
}

let store: Store<UpdateStoreSchema> | null = null
let lastResult: UpdateCheckResult | null = null

/** Send an event to all renderer windows. */
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

function updateStatus(status: UpdateStatus, fields: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  const result: UpdateCheckResult = {
    currentVersion: app.getVersion(),
    ...fields,
    status,
  }
  lastResult = result
  broadcastToRenderers('update:status', result)
  return result
}

function getStore(): Store<UpdateStoreSchema> {
  if (store === null) {
    store = new Store<UpdateStoreSchema>({
      name: 'auto-updater',
      defaults: {
        lastUpdateCheck: 0,
        mode: 'auto',
      },
    })
  }
  return store
}

function getDisabledByEnv(): boolean {
  return process.env.OUROBOROS_DISABLE_AUTO_UPDATE === '1'
}

function canRunRealUpdater(): boolean {
  return shouldRunRealUpdater({
    platform: process.platform,
    isPackaged: app.isPackaged,
    disabledByEnv: getDisabledByEnv(),
  })
}

export function getUpdatePreferences(): UpdatePreferences {
  return {
    mode: normalizeUpdateMode(getStore().get('mode')),
  }
}

export function setUpdatePreferences(preferences: UpdatePreferences): void {
  getStore().set('mode', normalizeUpdateMode(preferences.mode))
}

export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (process.env.NODE_ENV === 'test') {
    const forcedVersion = readForcedUpdateVersion()
    if (forcedVersion) {
      broadcastToRenderers('update:downloaded', forcedVersion)
      return updateStatus('downloaded', { latestVersion: forcedVersion })
    }
    return updateStatus('not-available')
  }

  if (getUpdatePreferences().mode === 'off') {
    return updateStatus('not-available')
  }

  if (!canRunRealUpdater()) {
    return updateStatus('not-available')
  }

  try {
    getStore().set('lastUpdateCheck', Date.now())
    updateStatus('checking')
    await autoUpdater.checkForUpdates()
    return lastResult ?? updateStatus('not-available')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return updateStatus('error', { errorMessage: message })
  }
}

export function initAutoUpdater(): void {
  // Do not auto-download — we trigger it ourselves after the check.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // ── Events → renderer IPC ──────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    updateStatus('checking')
    broadcastToRenderers('update:checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updateStatus('available', { latestVersion: info.version })
    broadcastToRenderers('update:available', info.version)
    // Start background download
    void autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    updateStatus('not-available', { latestVersion: info.version })
    broadcastToRenderers('update:not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    updateStatus('downloading', { latestVersion: lastResult?.latestVersion })
    broadcastToRenderers('update:download-progress', progress.percent)
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    updateStatus('downloaded', { latestVersion: info.version })
    broadcastToRenderers('update:downloaded', info.version)
  })

  autoUpdater.on('error', (err: Error) => {
    updateStatus('error', { errorMessage: err.message })
    broadcastToRenderers('update:error', err.message)
  })

  // ── Initial check (respecting 24h throttle) ────────────────────────

  const forcedVersion = process.env.OUROBOROS_TEST_UPDATE_DOWNLOADED_VERSION ?? readForcedUpdateVersion()
  if (forcedVersion) {
    const delayMs = Number(process.env.OUROBOROS_TEST_UPDATE_DOWNLOADED_DELAY_MS ?? '50')
    setTimeout(() => {
      updateStatus('downloaded', { latestVersion: forcedVersion })
      broadcastToRenderers('update:downloaded', forcedVersion)
    }, Number.isFinite(delayMs) ? delayMs : 50)
  }

  if (process.env.NODE_ENV === 'test' || process.env.OUROBOROS_TEST_SKIP_AUTO_UPDATE_CHECK === '1') {
    return
  }

  const store = getStore();
  const now = Date.now()

  if (
    shouldCheckForUpdatesOnLaunch({
      mode: getUpdatePreferences().mode,
      platform: process.platform,
      isPackaged: app.isPackaged,
      disabledByEnv: getDisabledByEnv(),
      lastUpdateCheck: store.get('lastUpdateCheck'),
      now,
    })
  ) {
    store.set('lastUpdateCheck', now)
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err)
    })
  }
}

export function handleInstallUpdate(): void {
  recordInstallUpdateRequest()

  const logPath = process.env.OUROBOROS_TEST_INSTALL_UPDATE_LOG_PATH ??
    (process.env.NODE_ENV === 'test' ? TEST_INSTALL_UPDATE_LOG_PATH : undefined)
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()}\n`)
  }

  if (process.env.NODE_ENV === 'test' || !canRunRealUpdater()) {
    return
  }

  autoUpdater.quitAndInstall()
}

function readForcedUpdateVersion(): string | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined
  try {
    return readFileSync(TEST_UPDATE_DOWNLOADED_PATH, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
