# Observe-Reflect-Crystallize-Dream Memory Plan

> **Current status:** Historical design plan. The current code includes
> observation logs, checkpoints, layered memory loaders, RSI runtime events,
> dream consolidation, crystallization over structured memory, and desktop RSI
> surfacing. Use `../README.md` and `docs/test-plan.md` for maintained status.

## Summary

Extend Ouroboros's RSI loop from `reflect -> crystallize -> dream -> evolve` to
`observe -> reflect -> crystallize -> dream -> evolve`.

The design introduces four file-based memory layers:

- `memory/observations/<session-id>.jsonl` for append-only atomic observations
- `memory/checkpoints/<session-id>.md` for current session state
- `memory/daily/YYYY-MM-DD.md` for recent working memory rollups
- `memory/MEMORY.md` for durable long-term knowledge

## Goals

- Preserve task continuity when the live conversation approaches the model context limit
- Make compaction safe and deterministic by checkpointing before history is trimmed
- Improve crystallization and dream-cycle quality by using structured observations instead of
  reconstructing state from raw transcripts
- Keep prompt memory stable and budgeted, with predictable sections instead of arbitrary retrieval

## Core Lifecycle

### Observe

Capture atomic observations from recent turns, tool results, constraints, decisions, and open loops.
Write them to `memory/observations/<session-id>.jsonl`.

### Reflect

Consume recent observations and current checkpoint state. Rewrite the checkpoint with:

- goal
- current plan
- constraints
- decisions made
- files or artifacts in play
- completed work
- open loops
- next best step
- durable memory candidates
- skill candidates

### Crystallize

Mine repeated observations and checkpoint patterns across sessions to propose reusable skills.

### Dream

Consolidate validated observations, checkpoints, and daily rollups into `memory/MEMORY.md`.
Promote durable facts, prune transient material, and resolve contradictions.

### Evolve

Track metrics and events for compaction success, memory reuse, and skill extraction so thresholds
and defaults can be tuned based on observed outcomes.

## Prompt Model

The prompt should load memory in this order:

1. durable memory from `memory/MEMORY.md`
2. latest checkpoint for the active session
3. recent daily working memory
4. short live conversation tail

Each layer should have an independent token budget. Trimming must happen by section boundaries, not
by arbitrary substring slicing.

## Phased Rollout

### Phase 1

- observation log types and writer
- checkpoint generation from observations
- prompt sectioning and memory loaders
- context-budget manager with flush and compaction thresholds
- one-shot `finishReason === "length"` recovery

### Phase 2

- reflection and dream consolidation over structured memory
- durable promotion and pruning rules
- evolution metrics and events

### Phase 3

- crystallization from repeated observation patterns
- tuning thresholds based on observed outcomes
- optional local retrieval over durable memory and transcript summaries
