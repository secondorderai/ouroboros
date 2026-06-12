# Ouroboros ARC-AGI-3 Benchmark Harness

This directory contains a self-contained harness for running the Ouroboros
agent on [ARC-AGI-3](https://docs.arcprize.org), the interactive game benchmark
from the ARC Prize. The agent plays unseen 64x64 grid games over the ARC HTTP
API, discovering each game's mechanics purely by acting and observing frames.

Everything lives under `benchmarks/arc-agi-3/`. No core Ouroboros packages are
modified; the integration point is the existing `.ouroboros` MCP server
support plus the JSON-RPC agent server.

## Files

- `run.ts`: CLI entry; parses flags and calls the runner.
- `src/options.ts`: shared `ArcBenchOptions` type.
- `src/client.ts`: typed ARC HTTP client (auth, cookies, retries).
- `src/render.ts`: frame rendering (full grid and compact diffs).
- `src/server.ts`: MCP stdio server exposing `list_games`, `reset`, `act`,
  `status` to the agent as `mcp__arc__*` tools.
- `src/runner.ts`: orchestration — scorecard, temp config, CLI spawn,
  per-game agent runs, summary.
- `skills/arc-agi-3/SKILL.md`: the agent's game-playing strategy skill.
- `tests/`: full suite against a deterministic mock ARC server (no network,
  no LLM).

## Prerequisites

- An ARC API key: register at [three.arcprize.org](https://three.arcprize.org)
  and export it as `ARC_API_KEY`.
- Dependencies installed in this folder:

  ```bash
  cd benchmarks/arc-agi-3
  bun install
  ```

- A configured `~/.ouroboros` with a working model block (the runner merges
  your model config into the temp benchmark config it generates). Example:

  ```json
  {
    "model": {
      "provider": "openai-chatgpt",
      "name": "gpt-5.5",
      "reasoningEffort": "medium"
    }
  }
  ```

## Usage

All commands run from `benchmarks/arc-agi-3/`.

Smoke test (one game, small budget):

```bash
ARC_API_KEY=... bun run bench -- --games ls20 --max-steps 30
```

Pilot (three games):

```bash
ARC_API_KEY=... bun run bench -- --games ls20,ft09,vc33 --max-steps 80
```

Flags:

- `--games a,b,c` or `--all`: which games to run (one is required).
- `--max-steps <n>`: LLM-step budget per game (default 80). Steps count LLM
  calls, not game actions — the agent batches up to 20 moves per call.
- `--tags a,b`: scorecard tags (default `ouroboros`).
- `--timeout-min <n>`: wall-clock timeout per game (default 30).
- `--reasoning-effort <level>`: model reasoning effort for game runs,
  `minimal|low|medium|high|max` (default `high` — grid-mechanics inference
  benefits from thinking budget).
- `--config <dir>`: use an existing config dir instead of a generated one.
- `--out <file>`: write results JSON.

## How it works

1. The runner opens a scorecard via `POST /api/scorecard/open` with your tags.
2. It writes a temp workdir containing a generated `.ouroboros` config: your
   model block, the verifier turned off, an absolute `skillDirectories` entry
   pointing at `skills/`, and a local MCP server block that launches
   `src/server.ts` with `ARC_API_KEY` and the scorecard id in its env.
3. It spawns the Ouroboros CLI in `--json-rpc` mode against that config and,
   per game, issues `agent/run` with `skillName: 'arc-agi-3'` and your
   `--max-steps` budget. The agent plays through the `mcp__arc__*` tools.
   If the agent stops early (models love to wrap up and summarize), the
   runner checks the scorecard and sends up to 4 continuation prompts in the
   same session until the budget is spent, the game is won, or the wall
   clock runs out.
4. Ground truth comes from `GET /api/scorecard/{card_id}` (not from agent
   self-reports). The runner closes the scorecard, prints a summary table
   (game, state, levels won, API actions, agent steps, stop reason), and the
   scorecard link in the form `https://arcprize.org/scorecards/{card_id}`.

## Cost

Expect roughly $1-6 per game on frontier models, depending on the configured
model, step budget, and how verbose the game frames are. A 3-game pilot at
`--max-steps 80` typically lands in the $3-20 range. Start with one game and a
small budget to gauge cost before scaling up.

## Verification without spending money

```bash
cd benchmarks/arc-agi-3
bun test
```

The suite runs entirely against a local mock ARC server. From the repo root,
`bun run verify` confirms the benchmark has zero impact on core packages (this
directory is outside the workspace).

## Troubleshooting

### `ARC_API_KEY` is missing

The MCP server and runner both require it. Register at
[three.arcprize.org](https://three.arcprize.org), then export `ARC_API_KEY`
before running. Tool calls return a clear error rather than crashing if the
key is absent.

### Rate limits (HTTP 429)

The ARC API allows around 600 requests per minute. The client honors
`Retry-After` and retries up to 3 times. If you run many games concurrently or
with very large move batches, back off and rerun.

### Verifier interference

The generated config sets `verifier.trigger: 'off'`. Game runs are long
tool-heavy sessions that would otherwise trip the completion verifier into
costly verify/retry loops. If you pass your own `--config`, make sure it does
the same.

### Scorecard page asks for login

Viewing `https://arcprize.org/scorecards/{card_id}` requires being logged in
to your arcprize.org account. The runner's printed summary table contains the
same ground-truth numbers if you cannot open the page.

### Agent seems to forget mechanics mid-game

Long runs compact context. The skill instructs the agent to keep a "mechanics
notes" block in every reply, which survives compaction. If the agent still
flails, lower `--max-steps` per attempt or check that the skill loaded (the
runner passes `skillName: 'arc-agi-3'` on every `agent/run`).
