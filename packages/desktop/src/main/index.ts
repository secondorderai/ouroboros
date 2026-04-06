/**
 * Ouroboros Desktop — main process entry point.
 *
 * Creates the browser window, manages the CLI child process lifecycle,
 * handles theme changes, and initializes the auto-updater and crash-rollback.
 */

import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { initAutoUpdater } from "./auto-updater.js";
import { initCrashRollback } from "./crash-rollback.js";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In development, load from the Vite dev server; in production, load the
  // built renderer HTML.
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Theme handling ──────────────────────────────────────────────────────

function setupThemeHandlers(): void {
  ipcMain.handle("theme:get", () => {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });

  ipcMain.on("theme:set", (_event, mode: "light" | "dark" | "system") => {
    nativeTheme.themeSource = mode;
  });

  nativeTheme.on("updated", () => {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("theme:changed", theme);
    }
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Safety: crash-rollback runs first, before any heavy initialization,
  // so rapid-crash detection works even if window creation fails.
  initCrashRollback();

  createWindow();
  setupThemeHandlers();

  // Auto-updater after the window is created so IPC events reach the renderer.
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
