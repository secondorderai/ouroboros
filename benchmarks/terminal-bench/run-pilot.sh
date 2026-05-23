#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JOBS_DIR="${OUROBOROS_TBENCH_JOBS_DIR:-/private/tmp/ouroboros-tbench/jobs}"
N_CONCURRENT="${OUROBOROS_TBENCH_N_CONCURRENT:-4}"
CONFIG_PATH="${OUROBOROS_TBENCH_CONFIG_PATH:-$HOME/.ouroboros}"

export OUROBOROS_TBENCH_MAX_STEPS="${OUROBOROS_TBENCH_MAX_STEPS:-50}"
export OUROBOROS_TBENCH_CONFIG_PATH="$CONFIG_PATH"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required. Install it from https://docs.astral.sh/uv/." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required. Install Docker Desktop and start it." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker daemon is not reachable. Start Docker Desktop, then retry." >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "error: $CONFIG_PATH is required. Run Ouroboros auth login and configure the default model first." >&2
  exit 1
fi

if [[ -n "${OUROBOROS_TBENCH_MODEL:-}" && "${OUROBOROS_TBENCH_MODEL}" == openai/* && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "error: OPENAI_API_KEY is required when OUROBOROS_TBENCH_MODEL uses the openai provider." >&2
  exit 1
fi

if command -v harbor >/dev/null 2>&1; then
  HARBOR_CMD=(harbor)
else
  HARBOR_CMD=(uv tool run harbor)
fi

mkdir -p "$JOBS_DIR"

echo "Running Ouroboros Terminal-Bench 2.0 pilot"
echo "repo: $REPO_ROOT"
echo "jobs: $JOBS_DIR"
echo "config: $CONFIG_PATH"
echo "model: ${OUROBOROS_TBENCH_MODEL:-from ~/.ouroboros}"
echo "reasoning: ${OUROBOROS_TBENCH_REASONING:-from ~/.ouroboros/default}"
echo "max steps: $OUROBOROS_TBENCH_MAX_STEPS"
echo "concurrency: $N_CONCURRENT"

cd "$REPO_ROOT"

PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
  "${HARBOR_CMD[@]}" run \
    --dataset terminal-bench@2.0 \
    --agent-import-path ouroboros_tbench_agent:OuroborosInstalledAgent \
    --n-concurrent "$N_CONCURRENT" \
    --jobs-dir "$JOBS_DIR" \
    "$@"
