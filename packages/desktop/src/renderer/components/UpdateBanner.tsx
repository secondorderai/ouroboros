/**
 * UpdateBanner — fixed banner at the top of the app that appears when
 * an update has been downloaded and is ready to install.
 *
 * Listens to IPC events from the main process auto-updater:
 *   - update:downloaded  → show the banner with the new version
 *   - update:error       → (optional) could show an error, but we stay silent
 *
 * User actions:
 *   - "Restart now" → sends update:install IPC to main
 *   - Dismiss button → hides the banner
 */

import React, { useCallback, useEffect, useState } from "react";

declare global {
  interface Window {
    electronAPI?: {
      onUpdateDownloaded: (callback: (version: string) => void) => () => void;
      installUpdate: () => void;
    };
  }
}

const bannerStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "12px",
  padding: "8px 16px",
  backgroundColor: "#1a73e8",
  color: "#ffffff",
  fontSize: "14px",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const buttonBaseStyle: React.CSSProperties = {
  border: "none",
  borderRadius: "4px",
  padding: "4px 12px",
  fontSize: "13px",
  cursor: "pointer",
};

const restartButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  backgroundColor: "#ffffff",
  color: "#1a73e8",
  fontWeight: 600,
};

const dismissButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  backgroundColor: "transparent",
  color: "#ffffff",
  textDecoration: "underline",
};

export function UpdateBanner(): React.ReactElement | null {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanup = api.onUpdateDownloaded((v: string) => {
      setVersion(v);
      setDismissed(false);
    });

    return cleanup;
  }, []);

  const handleRestart = useCallback(() => {
    window.electronAPI?.installUpdate();
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!version || dismissed) {
    return null;
  }

  return (
    <div style={bannerStyle} role="alert">
      <span>
        Update available (v{version}). Restart to apply.
      </span>
      <button style={restartButtonStyle} onClick={handleRestart}>
        Restart now
      </button>
      <button style={dismissButtonStyle} onClick={handleDismiss}>
        Dismiss
      </button>
    </div>
  );
}
