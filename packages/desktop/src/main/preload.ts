import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type CLIStatus, type Theme, type ElectronAPI, type OuroborosAPI, type OpenDialogOptions } from '../shared/protocol'

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
    return () => { ipcRenderer.removeListener('theme:nativeChanged', handler) }
  },
  getPlatform: () => ipcRenderer.invoke('platform:get'),
  toggleSidebar: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('sidebar:toggle', handler)
    return () => { ipcRenderer.removeListener('sidebar:toggle', handler) }
  }
}

// ── Ouroboros API (CLI JSON-RPC bridge) ────────────────────────────

const ouroborosAPI: OuroborosAPI = {
  rpc: async (method: string, params?: unknown) => {
    const response = await ipcRenderer.invoke(
      IPC_CHANNELS.RPC_REQUEST,
      method,
      params as Record<string, unknown> | undefined,
    )
    if (response.ok) {
      return response.result
    } else {
      const error = new Error(response.error.message)
      error.name = response.error.name
      throw error
    }
  },

  onNotification: (channel: string, callback: (params: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, method: string, params: unknown) => {
      if (method === channel) callback(params)
    }
    ipcRenderer.on(IPC_CHANNELS.CLI_NOTIFICATION, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.CLI_NOTIFICATION, handler) }
  },

  showOpenDialog: async (options: OpenDialogOptions) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options) as Promise<string | null>
  },

  onCLIStatus: (callback: (status: CLIStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: CLIStatus) => {
      callback(status)
    }
    ipcRenderer.on(IPC_CHANNELS.CLI_STATUS, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.CLI_STATUS, handler) }
  },
}

// ── Expose to renderer ────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
contextBridge.exposeInMainWorld('ouroboros', ouroborosAPI)
