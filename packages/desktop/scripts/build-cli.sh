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
rm -f \
  "$OUT_DIR/ouroboros" \
  "$OUT_DIR/ouroboros.exe" \
  "$OUT_DIR/ouroboros-darwin-arm64" \
  "$OUT_DIR/ouroboros-darwin-x64" \
  "$OUT_DIR/cli.js.map"

if [[ "$OSTYPE" == darwin* ]]; then
  echo "==> Building macOS release binaries for both architectures ..."

  if [[ "$(uname -m)" == "arm64" ]]; then
    cp "$CLI_DIR/dist/ouroboros" "$OUT_DIR/ouroboros-darwin-arm64"
    chmod +x "$OUT_DIR/ouroboros-darwin-arm64"
    echo "    Copied host ouroboros-darwin-arm64"

    bun build --compile --minify --sourcemap ./src/cli.ts --target=bun-darwin-x64 --outfile "$OUT_DIR/ouroboros-darwin-x64"
    chmod +x "$OUT_DIR/ouroboros-darwin-x64"
    echo "    Built ouroboros-darwin-x64"
  else
    cp "$CLI_DIR/dist/ouroboros" "$OUT_DIR/ouroboros-darwin-x64"
    chmod +x "$OUT_DIR/ouroboros-darwin-x64"
    echo "    Copied host ouroboros-darwin-x64"

    bun build --compile --minify --sourcemap ./src/cli.ts --target=bun-darwin-arm64 --outfile "$OUT_DIR/ouroboros-darwin-arm64"
    chmod +x "$OUT_DIR/ouroboros-darwin-arm64"
    echo "    Built ouroboros-darwin-arm64"
  fi
fi

# Copy the compiled binary (ouroboros on Unix, ouroboros.exe on Windows)
if [[ "$OSTYPE" != darwin* && -f "$CLI_DIR/dist/ouroboros.exe" ]]; then
  cp "$CLI_DIR/dist/ouroboros.exe" "$OUT_DIR/"
  echo "    Copied ouroboros.exe"
fi

if [[ "$OSTYPE" != darwin* && -f "$CLI_DIR/dist/ouroboros" ]]; then
  cp "$CLI_DIR/dist/ouroboros" "$OUT_DIR/"
  chmod +x "$OUT_DIR/ouroboros"
  echo "    Copied ouroboros"
fi

echo "==> CLI build complete."
ls -lh "$OUT_DIR"/ouroboros*
