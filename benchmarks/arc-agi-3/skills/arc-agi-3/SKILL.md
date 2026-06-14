---
name: arc-agi-3
description: Play ARC-AGI-3 interactive grid games via the arc MCP tools — explore mechanics from observation, then exploit them to win levels.
---

# ARC-AGI-3 Game Agent Strategy

You are playing an unseen interactive game on a 64x64 color grid. Nothing about
the rules is given to you. You must discover the mechanics purely by acting and
observing how the frame changes, then exploit what you learn to raise the score
and win.

## Your tools

- `mcp__arc__list_games` — list available games. You should already know your
  game id from the goal; never re-list.
- `mcp__arc__reset {game_id}` — start (or restart) a game. Returns the initial
  frame, `state`, `score`, and `available_actions`. Use the **exact, lowercase
  game id from your goal** (e.g. `ls20-9607627b`). Never pass `card_id` — the
  scorecard is preconfigured by the harness; passing anything (even an empty
  string) overrides it and breaks the run.
- `mcp__arc__act {game_id, moves: [{action, x?, y?, note?}], render?}` —
  execute up to 40 moves in one call. Each move is `{action: 1-6, x?, y?,
  note?}`. `render` is `'full'` or `'diff'` (default `'diff'`). The batch stops
  early if the state or score changes, so trailing moves are never wasted.
- `mcp__arc__status {game_id?}` — re-read cached state (frame, score,
  available actions) with **no API call**. Use this instead of re-acting or
  re-resetting when you just need to look again.

You also have your **general tools** — `code-exec` (run TypeScript/JS), `bash`,
`file-write`/`file-read`. Use them. You are weak at spatial bookkeeping in your
head; code is not. See "Code-assisted reasoning" below.

## Protocol

1. **Always `reset` first.** A game must be reset before it accepts actions.
2. Actions **1-4 are direction-like** simple actions (commonly up/down/left/
   right, but verify — semantics vary per game). Action **5 is interact** (use/
   select/confirm/no-op — game-dependent). Action **6 is a click at `(x, y)`**,
   origin top-left, coordinates 0-63; it requires `x` and `y`.
3. **Only use actions listed in `available_actions`** from the latest
   response. Anything else is rejected and wastes a move.
4. Game `state` is one of `NOT_PLAYED`, `NOT_FINISHED`, `WIN`, `GAME_OVER`.
   `score` is the number of levels completed.

## Reading frames: objects, not pixels

- **Every full frame comes with an object inventory** after the hex grid:
  the background (`bg=<color> (<N> cells)`) plus connected components with
  color, dimensions, cell count, and position, e.g.
  `color 3 5x5 rect (25 cells) at (34,40)..(38,44)`.
- **`act` results include object-movement lines.** Per-move one-liners are
  annotated when a move is one clean object motion, e.g.
  `#2 ACTION4 → 52 cells changed (color 3 5x5 moved (34,40)→(34,45))`, and
  diff renders end with an `objects:` section summarizing moves, appearances,
  and disappearances across the whole batch.
- **Identify the player by probing**: the object whose `moved` line tracks
  your direction actions is the one you control.
- **Track positions via the object lines** — do not re-parse the hex grid to
  find a sprite you already know. The hex grid is for layout questions (walls,
  paths, what surrounds a cell); the object lines are for state tracking.

## Exploration doctrine

- **Probe before you plan.** After reset, try each available action once (one
  small batch per probe) and study the frame diff each produced. Which cells
  changed? Did something move, appear, disappear, change color?
- **Hold competing hypotheses.** Maintain 2-3 explicit candidate theories about
  any unknown mechanic (e.g. "A5 toggles a switch" vs "A5 picks up the item
  under me" vs "A5 is a no-op"). State them in your reply.
- **Choose the discriminating action.** When unsure, pick the move whose outcome
  differs most between your live hypotheses — the one that *eliminates* the most
  theories — not a random probe. After the result, cross off every hypothesis it
  contradicts and say which survive.
- **Test the surviving hypothesis cheaply**, then **exploit**: once confident,
  batch a full move sequence toward the goal in a single `act` call.
- **After every score increase, re-explore.** Levels often introduce new
  mechanics; do a quick probe pass before committing to long sequences.
- If a probe produces no visible change, note that too — walls, disabled
  actions, and no-ops are information.

## Budget discipline

You have a fixed LLM-step budget stated in your goal. Every reply you produce
costs one step, so:

- **Batch confident sequences** — up to 40 moves per `act` call. One call with
  30 moves costs the same step budget as one call with 1 move.
- Keep `render: 'diff'` (the default). Only request `'full'` when you are
  disoriented or the diff says a large fraction of the board changed.
- Use `status` to re-inspect state instead of issuing extra actions.
- Never call `list_games` mid-run.
- Do not spend steps narrating; spend them acting. Short replies, big batches.

## Level macros (required)

Dying is cheap **only if recovery is cheap**. A reset restarts the game from
level 1, so without a recorded path you pay for every past level again.

- **The moment you complete a level, write down the exact move sequence that
  cleared it** (every action, in order, with coordinates for action 6) in your
  mechanics notes as a numbered macro, e.g.
  `L1 macro (9 moves): A2 A2 A2 A4 A4 A6(30,30) A4 A4 A2`.
- **After every GAME_OVER: reset, then replay your macro chain immediately** —
  one `act` call per level (macros fit in a single 40-move batch). Do not
  explore, re-verify, or "check the frame first" on levels you have already
  solved; the early-stop on score change confirms each level as you pass it.
- If a macro desyncs (the score does not advance where it should), the level
  layout may be randomized — fall back to exploration for that level only, and
  update the macro when you re-clear it.
- **Never re-explore a solved level.** All fresh thinking belongs to the
  frontier level. A death should cost you 1-2 steps per solved level, not a
  re-discovery.
- **No blind coordinate sweeps.** Clicking a grid row cell-by-cell hoping
  something happens burns the budget fastest of all. Aim action 6 only at
  visible objects from the inventory; if you have no hypothesis, re-read your
  notes and the object list instead of sweeping.

## Death attribution (required)

Repeated identical deaths are the fastest way to waste a budget. Before you
`reset` after any **GAME_OVER**:

- **Write down what killed you.** Record the last 1-3 actions, the object
  positions just before death, and your single best guess at the cause ("died
  moving onto the red cell at (12,7)"). Append it to a `Deaths:` list in your
  mechanics notes.
- **Maintain a danger model.** Keep a running list of moves/contexts that caused
  death. **Never repeat a move that killed you in the same context.** If unsure
  what killed you, use `code-exec` on the frame history (below) to find the exact
  pre-death transition: the last `act` record before `state=GAME_OVER`.
- Treat a death you cannot explain as the top priority to investigate, not to
  retry blindly.

## Code-assisted reasoning (your strongest tool)

Do not solve grids in your head. Every `reset`/`act` appends the raw grid to a
JSONL file whose absolute path is printed in the `reset` output as
`frame_history=...` (also `./arc-history-<game_id>.jsonl`). Each line is
`{seq, t, action, x, y, score, state, available_actions, frame}` where `frame`
is the exact 64x64 integer grid. This file persists even after your chat context
is compacted — it is your durable memory of the whole run.

Use `code-exec` to do the reasoning code is good at and you are not:

1. **Exact analysis.** Load the history, compute precise cell diffs, segment
   connected components, and track each object's position over time.
2. **Infer the transition model.** Test a hypothesized rule against every
   recorded `(state, action, next_state)` triple — "does A2 always move my
   object down by 1 unless blocked?" Code confirms or refutes instantly across
   all observations.
3. **Simulate and search.** Build a forward model of the level in code and
   search (BFS/greedy) for an action sequence that reaches the goal, then execute
   that sequence via `act`. The game has **no undo** — death restarts at level 1
   — so simulate paths in code *before* committing them.
4. **Find the killer.** Diff the frames straddling a GAME_OVER to see exactly
   what changed when you died.

Write a reusable analysis script once and rerun it as history grows; do not
regenerate huge analyses every step. Your code must be **general** — it operates
on the observed history, never hardcoded game-specific answers (see Hard rules).

## Mechanics notes (required)

Long runs get their context compacted: raw frames and old tool results will be
dropped, but your own written replies survive in summarized form. Therefore
**every reply must end with a short "Mechanics notes" block** — a compact,
current summary of what you know:

```
Mechanics notes:
- Level: 2/?, score 1, state NOT_FINISHED
- I control: blue 2x2 block; A1=up A2=down A3=left A4=right
- Goal: reach the red cell; walls are gray (color 5)
- A5: no effect so far; A6: untested this level
- L1 macro (9 moves): A2 A2 A2 A4 A4 A6(30,30) A4 A4 A2
- Deaths: died moving onto red cell (12,7) — red = lethal, avoid
- Current plan: go right 6, down 3
```

Update it every turn. If you ever feel disoriented after compaction, your last
notes block plus one `status` call should fully re-orient you.

## Hard rules

- **No per-game hardcoded walkthroughs.** Even if you think you recognize the
  game id, learn the mechanics only from what you observe this run.
- Do not guess coordinates for action 6 blindly; aim at structures you can see
  in the frame.
- Treat rejected moves (not in `available_actions`) as a signal to re-check
  `status`, not as something to retry.

## End conditions

- On **GAME_OVER**: first do **death attribution** (record the cause), then
  `reset` and replay your macro chain, applying everything in your mechanics
  notes. Deaths are cheap; lost knowledge and repeated deaths are not.
- On **WIN**, or when your step budget is nearly exhausted: stop acting and
  produce a **final report** — levels completed, final score and state, and a
  summary of the mechanics you learned for each level.
