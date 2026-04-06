/**
 * Preload script — exposes a safe electronAPI to the renderer via
 * contextBridge.  All IPC communication goes through this bridge.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Auto-updater ────────────────────────────────────────────────────
  onUpdateDownloaded: (callback: (version: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, version: string) => {
      callback(version);
    };
    ipcRenderer.on("update:downloaded", handler);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener("update:downloaded", handler);
    };
  },

  installUpdate: () => {
    ipcRenderer.send("update:install");
  },

  // ── Theme ───────────────────────────────────────────────────────────
  getTheme: () => ipcRenderer.invoke("theme:get"),

  setTheme: (mode: "light" | "dark" | "system") => {
    ipcRenderer.send("theme:set", mode);
  },

  onThemeChanged: (callback: (theme: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: string) => {
      callback(theme);
    };
    ipcRenderer.on("theme:changed", handler);
    return () => {
      ipcRenderer.removeListener("theme:changed", handler);
    };
  },
});
