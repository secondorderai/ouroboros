---
name: movement-bfs-frontier
description: Use inferred direction deltas to search toward unvisited safe positions after simple action probes identify a controlled object.
license: Apache-2.0
executor: movement_bfs
triggers:
  - movement_deltas_known
  - simple_actions_available
priority: 90
metadata:
  author: ouroboros-rsi
  version: "1.0"
---

# Movement BFS Frontier

Use this skill when simple action probes show that actions 1-4 move a stable
foreground object. Treat the moved object as the controlled object only after
the transition model has observed consistent deltas.

Plan by building a local movement graph from the current inferred position,
learned action deltas, blocked edges, death edges, and visited positions. Prefer
short paths to unvisited safe cells. Never choose an edge already observed to
cause `GAME_OVER` or no visible change from the same state.

This skill is intentionally generic. It must not store exact game ids, frame
hashes, solved-level walkthroughs, or fixed coordinates from public games.
