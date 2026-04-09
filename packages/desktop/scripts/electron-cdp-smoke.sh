#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/packages/desktop"
APP_ENTRY="$DESKTOP_DIR/out/main/index.js"
LOG_FILE="${TMPDIR:-/tmp}/ouroboros-electron-cdp.log"
DEBUG_PORT="${OUROBOROS_ELECTRON_DEBUG_PORT:-9222}"

echo "Electron CDP smoke harness"

if ! command -v curl >/dev/null 2>&1; then
  echo "STOP: Missing curl"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "STOP: Missing jq"
  exit 1
fi

if ! command -v websocat >/dev/null 2>&1 && ! command -v wscat >/dev/null 2>&1; then
  echo "STOP: Missing WebSocket CLI (install websocat or wscat before running this smoke test)"
  exit 1
fi

if [[ ! -f "$APP_ENTRY" ]]; then
  echo "Build output missing: $APP_ENTRY"
  echo "Run: cd $DESKTOP_DIR && bun run build:vite"
  exit 1
fi

echo "GATE 1: build artifact present"

cd "$DESKTOP_DIR"
./node_modules/.bin/electron "$APP_ENTRY" \
  --remote-debugging-port="$DEBUG_PORT" \
  --enable-logging \
  --log-file="$LOG_FILE" \
  >/dev/null 2>&1 &
APP_PID=$!

cleanup() {
  kill "$APP_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "GATE 2: launched Electron with file-based logging (pid=$APP_PID)"
sleep 3
echo "GATE 3: waited for initialization"

if ! ps -p "$APP_PID" >/dev/null 2>&1; then
  echo "GATE 4 FAILED: Electron process exited"
  cat "$LOG_FILE"
  exit 1
fi

if ! curl -sf "http://127.0.0.1:$DEBUG_PORT/json/list" >/dev/null; then
  echo "GATE 4 FAILED: CDP endpoint unavailable"
  cat "$LOG_FILE"
  exit 1
fi

echo "GATE 4: process and CDP endpoint healthy"
echo "GATE 5: runtime logs"
cat "$LOG_FILE"

if grep -Eq "(ERROR|FATAL|CRITICAL|Segmentation|Uncaught Exception)" "$LOG_FILE"; then
  echo "GATE 6 FAILED: fatal patterns detected in logs"
  exit 1
fi

echo "GATE 6: logs clean"

TARGETS_JSON="$(curl -sf "http://127.0.0.1:$DEBUG_PORT/json/list")"
echo "$TARGETS_JSON" | jq '.'

WS_URL="$(echo "$TARGETS_JSON" | jq -r 'map(select(.type == "page")) | .[0].webSocketDebuggerUrl')"
if [[ -z "$WS_URL" || "$WS_URL" == "null" ]]; then
  echo "No renderer WebSocket target found"
  exit 1
fi

echo "Renderer WebSocket: $WS_URL"
echo "CDP smoke harness completed. Drive CDP commands manually or from a wrapper script."
