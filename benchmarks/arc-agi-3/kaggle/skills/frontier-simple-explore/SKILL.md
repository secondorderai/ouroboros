---
name: frontier-simple-explore
description: Prefer safe untried simple actions from the current state when no higher-confidence solver has a plan.
license: Apache-2.0
executor: frontier_explore
triggers:
  - simple_actions_available
  - untried_edges_exist
priority: 35
metadata:
  author: ouroboros-rsi
  version: "1.0"
---

# Frontier Simple Explore

Use this skill as a generic fallback when actions 1-5 or 7 are available and no
stronger movement or click-board plan is ready. Prefer simple actions that have
not yet been tried from the current frame hash.

Avoid actions known to be no-ops or dangerous from the same level and state.
This skill keeps exploration systematic while preserving budget for stronger
solvers and Gemma plan selection.

The skill must remain game-agnostic and must not contain public-game ids,
static macros, frame hashes, or fixed public-game action sequences.
