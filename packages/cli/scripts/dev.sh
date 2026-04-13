#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 0 ]; then
  exec bun run src/cli.ts "$@"
fi

exec bun run --watch src/cli.ts
