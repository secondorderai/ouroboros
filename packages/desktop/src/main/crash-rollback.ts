/**
 * Crash-rollback detection.
 *
 * Counts rapid launches (within 60 seconds of each other) using electron-store.
 * After 3 rapid crashes, shows a dialog offering to download the previous version.
 * Resets the counter after 60 seconds of stable uptime.
 */

import { app, dialog, shell } from "electron";
import Store from "electron-store";

const RAPID_LAUNCH_WINDOW_MS = 60_000; // 60 seconds
const CRASH_THRESHOLD = 3;
const STABLE_UPTIME_MS = 60_000; // 60 seconds

interface CrashStoreSchema {
  rapidLaunchCount: number;
  lastLaunchTimestamp: number;
}

let store: Store<CrashStoreSchema> | null = null;

function getStore(): Store<CrashStoreSchema> {
  if (store === null) {
    store = new Store<CrashStoreSchema>({
      name: "crash-rollback",
      defaults: {
        rapidLaunchCount: 0,
        lastLaunchTimestamp: 0,
      },
    });
  }
  return store;
}

export function initCrashRollback(): void {
  const store = getStore();
  const now = Date.now();
  const lastLaunch = store.get("lastLaunchTimestamp");
  const elapsed = now - lastLaunch;

  // If this launch happened within the rapid-launch window, increment counter.
  // Otherwise reset it.
  if (elapsed < RAPID_LAUNCH_WINDOW_MS && lastLaunch > 0) {
    const count = store.get("rapidLaunchCount") + 1;
    store.set("rapidLaunchCount", count);

    if (count >= CRASH_THRESHOLD) {
      showRollbackDialog();
      // Reset so the dialog doesn't fire on every subsequent launch
      store.set("rapidLaunchCount", 0);
    }
  } else {
    store.set("rapidLaunchCount", 0);
  }

  store.set("lastLaunchTimestamp", now);

  // After 60 seconds of stable uptime, reset the counter
  setTimeout(() => {
    store.set("rapidLaunchCount", 0);
  }, STABLE_UPTIME_MS);
}

async function showRollbackDialog(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Ouroboros — Stability Issue Detected",
    message:
      "Ouroboros has crashed several times in rapid succession. " +
      "This may be caused by a bad update.",
    detail:
      "Would you like to download the previous version from the releases page?",
    buttons: ["Open Releases Page", "Continue Anyway"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    await shell.openExternal(
      "https://github.com/secondorderai/ouroboros/releases"
    );
    app.quit();
  }
}
