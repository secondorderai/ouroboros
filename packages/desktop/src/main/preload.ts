import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type CLIStatus,
  type CLIStatusEvent,
  type ElectronAPI,
  type NotificationMap,
  type NotificationMethod,
  type OpenDialogOptions,
  type OuroborosAPI,
  type RpcArgs,
  type RpcMethod,
  type RpcMethodMap,
  type SaveArtifactArgs,
  type SaveArtifactResult,
  type Theme,
  type UpdateCheckResult,
  type UpdatePreferences,
} from '../shared/protocol'

const TEST_IPC_CHANNELS = {
  SET_RPC_OVERRIDE: 'ouroboros:test:set-rpc-override',
  CLEAR_RPC_OVERRIDES: 'ouroboros:test:clear-rpc-overrides',
  EMIT_NOTIFICATION: 'ouroboros:test:emit-notification',
  EMIT_CLI_STATUS: 'ouroboros:test:emit-cli-status',
  EMIT_UPDATE_DOWNLOADED: 'ouroboros:test:emit-update-downloaded',
  GET_INSTALL_UPDATE_COUNT: 'ouroboros:test:get-install-update-count',
  RESET_INSTALL_UPDATE_COUNT: 'ouroboros:test:reset-install-update-count',
} as const

// ── Electron API (theme, platform, sidebar) ───────────────────────

const electronAPI: ElectronAPI = {
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: Theme) => ipcRenderer.invoke('theme:set', theme),
  getNativeTheme: () => ipcRenderer.invoke('theme:getNative'),
  onNativeThemeChanged: (callback: (theme: 'light' | 'dark') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') => {
      callback(theme)
    }
    ipcRenderer.on('theme:nativeChanged', handler)
    return () => {
      ipcRenderer.removeListener('theme:nativeChanged', handler)
    }
  },
  getPlatform: () => ipcRenderer.invoke('platform:get'),
  toggleSidebar: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('sidebar:toggle', handler)
    return () => {
      ipcRenderer.removeListener('sidebar:toggle', handler)
    }
  },
  openExternal: (url: string) => {
    ipcRenderer.send('shell:openExternal', url)
  },
  openArtifact: (path: string) => {
    ipcRenderer.send('shell:openArtifact', path)
  },
  getHomeDirectory: () => ipcRenderer.invoke('app:getHomeDirectory'),
  onUpdateDownloaded: (callback: (version: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, version: string) => {
      callback(version)
    }
    ipcRenderer.on('update:downloaded', handler)
    return () => {
      ipcRenderer.removeListener('update:downloaded', handler)
    }
  },
  onUpdateStatus: (callback: (result: UpdateCheckResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: UpdateCheckResult) => {
      callback(result)
    }
    ipcRenderer.on('update:status', handler)
    return () => {
      ipcRenderer.removeListener('update:status', handler)
    }
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  getUpdatePreferences: () =>
    ipcRenderer.invoke('update:getPreferences') as Promise<UpdatePreferences>,
  setUpdatePreferences: (preferences: UpdatePreferences) =>
    ipcRenderer.invoke('update:setPreferences', preferences) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke('update:install') as Promise<void>,
}

// ── Ouroboros API (CLI JSON-RPC bridge) ────────────────────────────

const ouroborosAPI: OuroborosAPI = {
  rpc: async <M extends RpcMethod>(method: M, ...args: RpcArgs<M>) => {
    const params = args[0] as RpcMethodMap[M]['params'] | undefined
    const response = await ipcRenderer.invoke(
      IPC_CHANNELS.RPC_REQUEST,
      method,
      params as Record<string, unknown> | undefined,
    )
    if (response.ok) {
      return response.result as RpcMethodMap[M]['result']
    } else {
      const error = new Error(response.error.message)
      error.name = response.error.name
      throw error
    }
  },

  onNotification: <M extends NotificationMethod>(
    channel: M,
    callback: (params: NotificationMap[M]) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, method: string, params: unknown) => {
      if (method === channel) callback(params as NotificationMap[M])
    }
    ipcRenderer.on(IPC_CHANNELS.CLI_NOTIFICATION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLI_NOTIFICATION, handler)
    }
  },

  showOpenDialog: async (options: OpenDialogOptions) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options) as Promise<
      string | string[] | null
    >
  },

  saveArtifact: async (args: SaveArtifactArgs) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SAVE_ARTIFACT, args) as Promise<SaveArtifactResult>
  },

  validateImageAttachments: async (paths: string[]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_IMAGE_ATTACHMENTS, paths)
  },

  registerDroppedImagePaths: async (paths: string[]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.REGISTER_DROPPED_IMAGE_PATHS, paths)
  },

  registerSessionImagePaths: async (paths: string[]) => {
    return ipcRenderer.invoke(IPC_CHANNELS.REGISTER_SESSION_IMAGE_PATHS, paths)
  },

  onCLIStatus: (callback: (status: CLIStatus) => void) => {
    // Two ordering hazards we have to defend against:
    //   1. Subscribing too late and missing past transitions (the CLI very
    //      often reaches `ready` before React mounts and registers this
    //      listener) — solved by replaying the status history.
    //   2. Replaying the history while a real-time event also arrives, causing
    //      the same transition to be delivered twice — solved by deduping on
    //      the monotonic `seq` from CLIProcessManager.
    // Attach the listener BEFORE asking for history so any event that fires
    // during the IPC roundtrip lands in the live channel and we can dedupe
    // it against the history when both arrive.
    let active = true
    const seenSeqs = new Set<number>()
    const deliver = (event: CLIStatusEvent) => {
      if (!active || seenSeqs.has(event.seq)) return
      seenSeqs.add(event.seq)
      callback(event.status)
    }
    const handler = (_event: Electron.IpcRendererEvent, payload: CLIStatusEvent) => {
      deliver(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.CLI_STATUS, handler)

    void ipcRenderer.invoke(IPC_CHANNELS.CLI_STATUS_HISTORY).then(
      (history: CLIStatusEvent[]) => {
        if (!active || !Array.isArray(history)) return
        for (const event of history) deliver(event)
      },
      () => {
        // History fetch is best-effort — if it errors (e.g. test harness
        // replaced the handler), the live channel still delivers transitions.
      },
    )

    return () => {
      active = false
      ipcRenderer.removeListener(IPC_CHANNELS.CLI_STATUS, handler)
    }
  },
}

// ── Expose to renderer ────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
contextBridge.exposeInMainWorld('ouroboros', ouroborosAPI)

if (process.env.NODE_ENV === 'test') {
  contextBridge.exposeInMainWorld('__ouroborosTest', {
    setRpcOverride: (method: string, override: unknown | null) =>
      ipcRenderer.invoke(TEST_IPC_CHANNELS.SET_RPC_OVERRIDE, method, override),
    clearRpcOverrides: () => ipcRenderer.invoke(TEST_IPC_CHANNELS.CLEAR_RPC_OVERRIDES),
    emitNotification: (method: string, params?: unknown) =>
      ipcRenderer.invoke(TEST_IPC_CHANNELS.EMIT_NOTIFICATION, method, params),
    emitCLIStatus: (status: CLIStatus) =>
      ipcRenderer.invoke(TEST_IPC_CHANNELS.EMIT_CLI_STATUS, status),
    emitUpdateDownloaded: (version: string) =>
      ipcRenderer.invoke(TEST_IPC_CHANNELS.EMIT_UPDATE_DOWNLOADED, version),
    getInstallUpdateCount: () =>
      ipcRenderer.invoke(TEST_IPC_CHANNELS.GET_INSTALL_UPDATE_COUNT) as Promise<number>,
    resetInstallUpdateCount: () => ipcRenderer.invoke(TEST_IPC_CHANNELS.RESET_INSTALL_UPDATE_COUNT),
  })
}
