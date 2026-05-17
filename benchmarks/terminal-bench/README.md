# Ouroboros Terminal-Bench 2.0 Pilot Harness

This directory contains a local pilot harness for running the Ouroboros CLI on
Terminal-Bench 2.0 through Harbor. It is meant to validate that Ouroboros can be
installed, built, and invoked inside Harbor task containers.

This is not a leaderboard submission package. It does not add audited
leaderboard metadata or a full ATIF trajectory converter.

## Files

- `ouroboros_tbench_agent.py`: Harbor `BaseInstalledAgent` adapter for
  Ouroboros.
- `run-pilot.sh`: local convenience script for a one-concurrency pilot run.

The directory name contains a hyphen, so it is not imported as a Python package.
`run-pilot.sh` adds this directory to `PYTHONPATH` and imports the adapter as:

```bash
ouroboros_tbench_agent:OuroborosInstalledAgent
```

## Prerequisites

- Docker Desktop installed and running.
- `uv` installed.
- Network access from task containers for installing Bun and calling the model
  provider.
- `OPENAI_API_KEY` exported in the shell.

Optional environment variables:

- `OUROBOROS_TBENCH_MODEL`, default `openai/gpt-5.5`
- `OUROBOROS_TBENCH_REASONING`, default `medium`
- `OUROBOROS_TBENCH_MAX_STEPS`, default `50`
- `OUROBOROS_TBENCH_N_CONCURRENT`, default `1`
- `OUROBOROS_TBENCH_TIMEOUT_SEC`, default `3600`
- `OUROBOROS_TBENCH_JOBS_DIR`, default `/private/tmp/ouroboros-tbench/jobs`

## Developer Execution Plan

1. Start Docker Desktop and verify the daemon is reachable:

   ```bash
   docker info
   ```

2. Export credentials:

   ```bash
   export OPENAI_API_KEY=...
   ```

3. Verify Harbor is available through `uv`:

   ```bash
   uv tool run harbor --help
   ```

4. Run the Harbor oracle sanity check:

   ```bash
   uv tool run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 1
   ```

5. Run the Ouroboros pilot:

   ```bash
   benchmarks/terminal-bench/run-pilot.sh
   ```

6. Inspect results:

   ```bash
   ls -la /private/tmp/ouroboros-tbench/jobs
   ```

   Open the latest Harbor job directory and inspect the trial `agent/`,
   `verifier/`, `result.json`, and `trial.log` files. Ouroboros logs are written
   as `agent/ouroboros.txt`, `agent/ouroboros-stdout.txt`, and
   `agent/ouroboros-stderr.txt`.

## Verification Without Running The Benchmark

Check shell syntax:

```bash
bash -n benchmarks/terminal-bench/run-pilot.sh
```

Validate the adapter import:

```bash
PYTHONPATH=benchmarks/terminal-bench \
  uv tool run --with harbor python -c "from ouroboros_tbench_agent import OuroborosInstalledAgent; print(OuroborosInstalledAgent.name())"
```

Run the repo verification suite:

```bash
bun run verify
```

## Troubleshooting

### Docker daemon is down

If `docker info` fails, start Docker Desktop and wait until it reports that the
engine is running.

### `OPENAI_API_KEY` is missing

`run-pilot.sh` exits early when `OPENAI_API_KEY` is empty because the default
model is `openai/gpt-5.5`.

### Harbor is missing

Use `uv run harbor --help`. If `uv` cannot resolve Harbor, install it with:

```bash
uv tool install harbor
```

### Container setup fails while installing Bun

Confirm the task container has outbound network access and can reach
`https://bun.sh`. Some Terminal-Bench tasks may intentionally restrict internet
access; those tasks are not suitable for this pilot adapter without pre-baking
Ouroboros and Bun into the agent image.

### Ouroboros build fails in the task container

Inspect `agent/ouroboros-stderr.txt` and `trial.log` in the latest Harbor job
directory. The adapter uploads a filtered copy of the current repo and runs
`bun install` followed by `bun run --filter @ouroboros/cli build`.
