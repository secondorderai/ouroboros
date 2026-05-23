#!/usr/bin/env bash
# Build the Ouroboros CLI into a standalone binary and copy it into
# packages/desktop/resources/cli/ so electron-builder can bundle it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
CLI_DIR="$DESKTOP_DIR/../cli"
OUT_DIR="$DESKTOP_DIR/resources/cli"
AGENT_BROWSER_OUT_DIR="$DESKTOP_DIR/resources/agent-browser"

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

echo "==> Preparing bundled Agent Browser binary ..."
rm -rf "$AGENT_BROWSER_OUT_DIR"
mkdir -p "$AGENT_BROWSER_OUT_DIR"

copy_agent_browser_package() {
  local package_dir="$1"
  if [[ ! -d "$package_dir/bin" || ! -d "$package_dir/skill-data" ]]; then
    echo "STOP: Agent Browser package is missing bin/ or skill-data/: $package_dir" >&2
    exit 1
  fi

  cp "$package_dir/package.json" "$AGENT_BROWSER_OUT_DIR/" 2>/dev/null || true
  cp "$package_dir/LICENSE" "$AGENT_BROWSER_OUT_DIR/" 2>/dev/null || true
  cp "$package_dir/README.md" "$AGENT_BROWSER_OUT_DIR/" 2>/dev/null || true
  cp -R "$package_dir/bin" "$AGENT_BROWSER_OUT_DIR/"
  cp -R "$package_dir/skill-data" "$AGENT_BROWSER_OUT_DIR/"
  if [[ -d "$package_dir/skills" ]]; then
    cp -R "$package_dir/skills" "$AGENT_BROWSER_OUT_DIR/"
  fi
  find "$AGENT_BROWSER_OUT_DIR/bin" -type f -name 'agent-browser*' -exec chmod +x {} \;
  echo "    Copied Agent Browser package from $package_dir"
}

infer_agent_browser_package_dir() {
  local bin_path="$1"
  local resolved_bin
  resolved_bin="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$bin_path")"
  local bin_dir
  bin_dir="$(dirname "$resolved_bin")"
  if [[ "$(basename "$bin_dir")" == "bin" ]]; then
    dirname "$bin_dir"
    return 0
  fi
  return 1
}

if [[ -n "${AGENT_BROWSER_PACKAGE_PATH:-}" ]]; then
  if [[ ! -d "$AGENT_BROWSER_PACKAGE_PATH" ]]; then
    echo "STOP: AGENT_BROWSER_PACKAGE_PATH does not exist: $AGENT_BROWSER_PACKAGE_PATH" >&2
    exit 1
  fi
  copy_agent_browser_package "$AGENT_BROWSER_PACKAGE_PATH"
elif [[ -n "${AGENT_BROWSER_BIN_PATH:-}" ]]; then
  if [[ ! -f "$AGENT_BROWSER_BIN_PATH" ]]; then
    echo "STOP: AGENT_BROWSER_BIN_PATH does not exist: $AGENT_BROWSER_BIN_PATH" >&2
    exit 1
  fi
  AGENT_BROWSER_PACKAGE_DIR="$(infer_agent_browser_package_dir "$AGENT_BROWSER_BIN_PATH" || true)"
  if [[ -n "$AGENT_BROWSER_PACKAGE_DIR" ]]; then
    copy_agent_browser_package "$AGENT_BROWSER_PACKAGE_DIR"
  else
    echo "STOP: AGENT_BROWSER_BIN_PATH must point to a binary inside an Agent Browser package bin/ directory. Set AGENT_BROWSER_PACKAGE_PATH instead." >&2
    exit 1
  fi
elif command -v agent-browser >/dev/null 2>&1; then
  AGENT_BROWSER_PACKAGE_DIR="$(infer_agent_browser_package_dir "$(command -v agent-browser)" || true)"
  if [[ -n "$AGENT_BROWSER_PACKAGE_DIR" ]]; then
    copy_agent_browser_package "$AGENT_BROWSER_PACKAGE_DIR"
  else
    echo "    Agent Browser found on PATH, but its package directory could not be inferred; packaged browser automation will report unavailable until release packaging provides AGENT_BROWSER_PACKAGE_PATH."
    touch "$AGENT_BROWSER_OUT_DIR/.gitkeep"
  fi
else
  echo "    Agent Browser package not found; packaged browser automation will report unavailable until release packaging provides one."
  touch "$AGENT_BROWSER_OUT_DIR/.gitkeep"
fi
