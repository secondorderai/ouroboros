/**
 * Auto-updater wrapper around electron-updater.
 *
 * - Checks for updates on app launch, at most once every 24 hours.
 * - Downloads updates in the background.
 * - Emits IPC events to the renderer so the UI can show an update banner.
 * - "Restart to apply" triggers autoUpdater.quitAndInstall().
 */

import pkg from "electron-updater";
const { autoUpdater } = pkg;
type UpdateInfo = pkg.UpdateInfo;
import { BrowserWindow } from "electron";
import Store from "electron-store";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { recordInstallUpdateRequest } from "./ipc-handlers";
import { TEST_INSTALL_UPDATE_LOG_PATH, TEST_UPDATE_DOWNLOADED_PATH } from "./test-paths";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface UpdateStoreSchema {
  lastUpdateCheck: number;
}

let store: Store<UpdateStoreSchema> | null = null;

/** Send an event to all renderer windows. */
function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function getStore(): Store<UpdateStoreSchema> {
  if (store === null) {
    store = new Store<UpdateStoreSchema>({
      name: "auto-updater",
      defaults: {
        lastUpdateCheck: 0,
      },
    });
  }
  return store;
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

  // ── Initial check (respecting 24h throttle) ────────────────────────

  const forcedVersion = process.env.OUROBOROS_TEST_UPDATE_DOWNLOADED_VERSION ?? readForcedUpdateVersion();
  if (forcedVersion) {
    const delayMs = Number(process.env.OUROBOROS_TEST_UPDATE_DOWNLOADED_DELAY_MS ?? '50');
    setTimeout(() => {
      broadcastToRenderers("update:downloaded", forcedVersion);
    }, Number.isFinite(delayMs) ? delayMs : 50);
  }

  if (process.env.NODE_ENV === "test" || process.env.OUROBOROS_TEST_SKIP_AUTO_UPDATE_CHECK === "1") {
    return;
  }

  const store = getStore();
  const lastCheck = store.get("lastUpdateCheck");
  const now = Date.now();

  if (now - lastCheck >= TWENTY_FOUR_HOURS_MS) {
    store.set("lastUpdateCheck", now);
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Auto-update check failed:", err);
    });
  }
}

export function handleInstallUpdate(): void {
  recordInstallUpdateRequest();

  const logPath = process.env.OUROBOROS_TEST_INSTALL_UPDATE_LOG_PATH ??
    (process.env.NODE_ENV === "test" ? TEST_INSTALL_UPDATE_LOG_PATH : undefined);
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()}\n`);
  }

  if (process.env.NODE_ENV === "test") {
    return;
  }

  autoUpdater.quitAndInstall();
}

function readForcedUpdateVersion(): string | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  try {
    return readFileSync(TEST_UPDATE_DOWNLOADED_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
