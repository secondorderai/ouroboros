#!/usr/bin/env bash
# Build the Ouroboros CLI into a standalone binary and copy it into
# packages/desktop/resources/cli/ so electron-builder can bundle it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
CLI_DIR="$DESKTOP_DIR/../cli"
OUT_DIR="$DESKTOP_DIR/resources/cli"

echo "==> Building CLI binary from $CLI_DIR ..."
cd "$CLI_DIR"
bun build --compile --minify --sourcemap ./src/cli.ts --outfile dist/ouroboros

echo "==> Copying binary to $OUT_DIR ..."
mkdir -p "$OUT_DIR"

# Copy the compiled binary (ouroboros on Unix, ouroboros.exe on Windows)
if [[ -f "$CLI_DIR/dist/ouroboros.exe" ]]; then
  cp "$CLI_DIR/dist/ouroboros.exe" "$OUT_DIR/"
  echo "    Copied ouroboros.exe"
fi

if [[ -f "$CLI_DIR/dist/ouroboros" ]]; then
  cp "$CLI_DIR/dist/ouroboros" "$OUT_DIR/"
  chmod +x "$OUT_DIR/ouroboros"
  echo "    Copied ouroboros"
fi

echo "==> CLI build complete."
ls -lh "$OUT_DIR"/ouroboros*
