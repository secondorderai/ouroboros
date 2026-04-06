/**
 * Preload Script
 *
 * Exposes a typed API to the renderer process via contextBridge.
 * No Node.js APIs are directly accessible in the renderer — all
 * communication goes through the IPC channels defined here.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type CLIStatus } from '../shared/protocol'

// ── Types for the exposed API ──────────────────────────────────────

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<
    'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory'
  >
}

export interface OuroborosAPI {
  /** Send a JSON-RPC request to the CLI and wait for the response */
  rpc(method: string, params?: unknown): Promise<unknown>

  /** Subscribe to CLI notifications. Returns an unsubscribe function. */
  onNotification(channel: string, callback: (params: unknown) => void): () => void

  /** Show a native open-file dialog */
  showOpenDialog(options: OpenDialogOptions): Promise<string | null>

  /** Get the current effective theme ('light' or 'dark') */
  getTheme(): Promise<'light' | 'dark'>

  /** Set the theme preference */
  setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>

  /** Get the current OS platform */
  getPlatform(): Promise<'darwin' | 'win32'>

  /** Subscribe to CLI status changes. Returns an unsubscribe function. */
  onCLIStatus(callback: (status: CLIStatus) => void): () => void
}

// ── Implementation ─────────────────────────────────────────────────

const api: OuroborosAPI = {
  rpc: async (method: string, params?: unknown) => {
    const response = await ipcRenderer.invoke(
      IPC_CHANNELS.RPC_REQUEST,
      method,
      params as Record<string, unknown> | undefined,
    )

    // The main process wraps results in { ok, result } or { ok, error }
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
      if (method === channel) {
        callback(params)
      }
    }

    ipcRenderer.on(IPC_CHANNELS.CLI_NOTIFICATION, handler)

    // Return unsubscribe function for React useEffect cleanup
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLI_NOTIFICATION, handler)
    }
  },

  showOpenDialog: async (options: OpenDialogOptions) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options) as Promise<string | null>
  },

  getTheme: async () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_THEME) as Promise<'light' | 'dark'>
  },

  setTheme: async (theme: 'light' | 'dark' | 'system') => {
    await ipcRenderer.invoke(IPC_CHANNELS.SET_THEME, theme)
  },

  getPlatform: async () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PLATFORM) as Promise<'darwin' | 'win32'>
  },

  onCLIStatus: (callback: (status: CLIStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: CLIStatus) => {
      callback(status)
    }

    ipcRenderer.on(IPC_CHANNELS.CLI_STATUS, handler)

    // Return unsubscribe function for React useEffect cleanup
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CLI_STATUS, handler)
    }
  },
}

// ── Expose to renderer ─────────────────────────────────────────────

contextBridge.exposeInMainWorld('ouroboros', api)

// ── Type augmentation for renderer ─────────────────────────────────

declare global {
  interface Window {
    ouroboros: OuroborosAPI
  }
}
