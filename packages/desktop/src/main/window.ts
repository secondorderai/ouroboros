import { BrowserWindow, screen } from 'electron'
import Store from 'electron-store'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

let store: Store<{ windowBounds: WindowBounds }> | null = null

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 800
const MIN_HEIGHT = 600

function getDefaultBounds(): WindowBounds {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
  return {
    x: Math.round((screenWidth - DEFAULT_WIDTH) / 2),
    y: Math.round((screenHeight - DEFAULT_HEIGHT) / 2),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    isMaximized: false
  }
}

function getStore(): Store<{ windowBounds: WindowBounds }> {
  if (store === null) {
    store = new Store<{ windowBounds: WindowBounds }>()
  }
  return store
}

function getSavedBounds(): WindowBounds {
  const saved = getStore().get('windowBounds')
  if (!saved) return getDefaultBounds()

  // Validate that the saved bounds are still on a visible display
  const displays = screen.getAllDisplays()
  const isVisible = displays.some((display) => {
    const { x, y, width, height } = display.bounds
    return (
      saved.x >= x &&
      saved.x < x + width &&
      saved.y >= y &&
      saved.y < y + height
    )
  })

  if (!isVisible) return getDefaultBounds()
  return saved
}

export function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return

  const isMaximized = win.isMaximized()
  const bounds = win.getBounds()

  getStore().set('windowBounds', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized
  })
}

export function createWindowOptions(): Electron.BrowserWindowConstructorOptions {
  const bounds = getSavedBounds()
  const isMac = process.platform === 'darwin'

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#F5F6F7',
            symbolColor: '#0E1116',
            height: 40
          }
        }
      : {}),
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    backgroundColor: '#F5F6F7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // E2E tests run with `OUROBOROS_TEST_HIDE_WINDOW=1` so the BrowserWindow
      // is never `.show()`n. Chromium then treats the window as backgrounded
      // and (on Linux/xvfb especially) throttles `requestAnimationFrame` and
      // some timers to ~0 fps — which freezes `useStreamingBuffer`'s rAF flush
      // and makes every streaming-text assertion fail with "element not found"
      // on CI even though the same scenario passes when the window is shown.
      // Disabling the throttle in test mode keeps the renderer's rAF cadence
      // consistent with what the user sees in production (foregrounded
      // window). Production behaviour is unchanged.
      backgroundThrottling: process.env.NODE_ENV !== 'test',
    }
  }
}

export function restoreMaximized(win: BrowserWindow): void {
  const saved = getStore().get('windowBounds')
  if (saved?.isMaximized) {
    win.maximize()
  }
}
