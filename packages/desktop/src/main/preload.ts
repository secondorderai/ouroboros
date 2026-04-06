import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, Theme } from '../shared/protocol'

const api: ElectronAPI = {
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
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
