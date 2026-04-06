/**
 * Auto-updater wrapper around electron-updater.
 *
 * - Checks for updates on app launch, at most once every 24 hours.
 * - Downloads updates in the background.
 * - Emits IPC events to the renderer so the UI can show an update banner.
 * - "Restart to apply" triggers autoUpdater.quitAndInstall().
 */

import { autoUpdater, type UpdateInfo } from "electron-updater";
import { BrowserWindow, ipcMain } from "electron";
import Store from "electron-store";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface UpdateStoreSchema {
  lastUpdateCheck: number;
}

const store = new Store<UpdateStoreSchema>({
  name: "auto-updater",
  defaults: {
    lastUpdateCheck: 0,
  },
});

/** Send an event to all renderer windows. */
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

export function initAutoUpdater(): void {
  // Do not auto-download — we trigger it ourselves after the check.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Events → renderer IPC ──────────────────────────────────────────

  autoUpdater.on("checking-for-update", () => {
    broadcastToRenderers("update:checking");
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    broadcastToRenderers("update:available", info.version);
    // Start background download
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on("update-not-available", () => {
    broadcastToRenderers("update:not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcastToRenderers("update:download-progress", progress.percent);
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    broadcastToRenderers("update:downloaded", info.version);
  });

  autoUpdater.on("error", (err: Error) => {
    broadcastToRenderers("update:error", err.message);
  });

  // ── Renderer → main IPC ────────────────────────────────────────────

  ipcMain.on("update:install", () => {
    autoUpdater.quitAndInstall();
  });

  // ── Initial check (respecting 24h throttle) ────────────────────────

  const lastCheck = store.get("lastUpdateCheck");
  const now = Date.now();

  if (now - lastCheck >= TWENTY_FOUR_HOURS_MS) {
    store.set("lastUpdateCheck", now);
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Auto-update check failed:", err);
    });
  }
}
