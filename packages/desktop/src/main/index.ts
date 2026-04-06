import { app, BrowserWindow, ipcMain, nativeTheme, Menu } from 'electron'
import { join } from 'path'
import Store from 'electron-store'
import { createWindowOptions, saveBounds, restoreMaximized } from './window'
import type { Theme } from '../shared/protocol'

const store = new Store<{ theme: Theme }>()

let mainWindow: BrowserWindow | null = null

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    createWindow()

    // macOS: re-create window when dock icon is clicked
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function createWindow(): void {
  const options = createWindowOptions()

  mainWindow = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      preload: join(__dirname, '../preload/preload.mjs')
    }
  })

  // Restore maximized state
  restoreMaximized(mainWindow)

  // Show window when ready to prevent visual flash
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Save bounds on move/resize
  mainWindow.on('resized', () => {
    if (mainWindow) saveBounds(mainWindow)
  })
  mainWindow.on('moved', () => {
    if (mainWindow) saveBounds(mainWindow)
  })
  mainWindow.on('maximize', () => {
    if (mainWindow) saveBounds(mainWindow)
  })
  mainWindow.on('unmaximize', () => {
    if (mainWindow) saveBounds(mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Listen for native theme changes
  nativeTheme.on('updated', () => {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    mainWindow?.webContents.send('theme:nativeChanged', theme)
  })

  // Register Cmd/Ctrl+B for sidebar toggle
  const isMac = process.platform === 'darwin'

  // Use menu accelerator for Cmd/Ctrl+B
  const menu = Menu.buildFromTemplate([
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            mainWindow?.webContents.send('sidebar:toggle')
          }
        },
        { type: 'separator' as const },
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const }
            ]
          : [{ role: 'close' as const }])
      ]
    }
  ])
  Menu.setApplicationMenu(menu)

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('theme:get', (): Theme => {
    return store.get('theme', 'system')
  })

  ipcMain.handle('theme:set', (_event, theme: Theme) => {
    store.set('theme', theme)
  })

  ipcMain.handle('theme:getNative', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  ipcMain.handle('platform:get', () => {
    return process.platform
  })
}
