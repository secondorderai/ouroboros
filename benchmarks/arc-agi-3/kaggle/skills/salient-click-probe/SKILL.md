---
name: salient-click-probe
description: When coordinate clicks are available but no board model is confident, probe visible compact non-HUD objects before raw fallback actions.
license: Apache-2.0
executor: salient_click_probe
triggers:
  - action6_available
  - salient_objects_visible
priority: 55
metadata:
  author: ouroboros-rsi
  version: "1.0"
---

# Salient Click Probe

Use this skill when coordinate clicks are legal but the frame does not yet have
a confident regular-board model. Generate click probes from visible compact
foreground objects, preferring non-HUD objects with stable centers.

Skip coordinates that are known duds, known dangerous edges, or already tried
from the current state. This skill is for targeted probing only; it must not
perform blind coordinate sweeps.

Keep the skill generic. Do not include public-game walkthroughs or exact target
coordinates learned from previous public runs.
