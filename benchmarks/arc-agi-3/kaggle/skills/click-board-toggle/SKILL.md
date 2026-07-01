---
name: click-board-toggle
description: Detect regular rectangular board cells and click untried non-HUD cells while avoiding prior no-op, HUD-only, or death outcomes.
license: Apache-2.0
executor: click_board_toggle
triggers:
  - action6_available
  - regular_board_detected
priority: 80
metadata:
  author: ouroboros-rsi
  version: "1.0"
---

# Click Board Toggle

Use this skill when `ACTION6` is available and the frame contains repeated
rectangular components arranged like a board. Candidate targets are cell
centers from regular non-HUD tiles.

Classify click outcomes as no-op, HUD-only, region-change, score-change, or
death. Prefer untried board cells that previously caused board-region changes
or have no outcome yet. Avoid cells that already produced no visible change,
HUD-only changes, or death.

This skill describes a board-solving strategy, not a memorized board solution.
Do not encode public-game ids, exact frame hashes, or static coordinate lists.
