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
- **Form a hypothesis** about the mechanics: what do you control, what is the
  goal object, what do the actions do, what ends the level. State it
  explicitly in your reply.
- **Test the hypothesis cheaply**, then **exploit**: once confident, batch a
  full move sequence toward the goal in a single `act` call.
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

- On **GAME_OVER**: `reset` and replay, applying everything in your mechanics
  notes. Deaths are cheap; lost knowledge is not.
- On **WIN**, or when your step budget is nearly exhausted: stop acting and
  produce a **final report** — levels completed, final score and state, and a
  summary of the mechanics you learned for each level.
