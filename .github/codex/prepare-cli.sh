#!/usr/bin/env bash
set -euo pipefail

# Verification needs the CLI executable, not release packaging. In particular,
# do not rewrite the tracked Agent Browser distribution in resources/.
cd "$1/packages/cli"
mkdir -p ../desktop/resources/cli
bun build --compile --minify --sourcemap ./src/cli.ts \
  --outfile ../desktop/resources/cli/ouroboros
