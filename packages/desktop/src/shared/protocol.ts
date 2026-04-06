/**
 * JSON-RPC message type definitions shared between main and renderer processes.
 * These will be expanded when CLI spawning is implemented (ticket 03).
 */

/** Theme values supported by the app */
export type Theme = 'light' | 'dark' | 'system'

/** API exposed from main process to renderer via preload script */
export interface ElectronAPI {
  getTheme: () => Promise<Theme>
  setTheme: (theme: Theme) => Promise<void>
  getNativeTheme: () => Promise<'light' | 'dark'>
  onNativeThemeChanged: (callback: (theme: 'light' | 'dark') => void) => () => void
  getPlatform: () => Promise<NodeJS.Platform>
  toggleSidebar: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
