"""Search inside the induced model. Pure search: execution and
predicted-vs-observed checking belong to the director.

States are (grid bytes, counters) — exact and hashable. At the node cap
(default 20k) full-grid states cost tens of milliseconds, which buys the
simplicity of never reconstructing state from a factored encoding.
"""
from __future__ import annotations

import time
from collections import deque

from .grid import Grid, components, most_common_color
from .rules import Binding, ClickRule, Goal, MoveRule, RuleSet, State, is_goal, step
from .timeline import ActionSpec

SIMPLE_ACTIONS = (1, 2, 3, 4, 5, 7)


def _actions(state: State, rules: RuleSet, binding: Binding,
             legal: tuple[int, ...]) -> list[tuple[int, int | None, int | None]]:
    out: list[tuple[int, int | None, int | None]] = []
    move = next((r for r in rules if isinstance(r, MoveRule)), None)
    if move is not None:
        for action, _ in move.deltas:
            if action in legal:
                out.append((action, None, None))
    click_sources: set[int] = set()
    for r in rules:
        if isinstance(r, ClickRule):
            click_sources |= {src for src, _ in r.mapping}
    if 6 in legal and click_sources:
        bg = binding.bg(state.grid)
        for obj in components(state.grid, colors=click_sources, background=bg)[:16]:
            out.append((6, obj.centroid[0], obj.centroid[1]))
    return out


def plan(
    state: State,
    rules: RuleSet,
    binding: Binding,
    goal: Goal,
    legal: tuple[int, ...] = (1, 2, 3, 4),
    node_cap: int = 20000,
    deadline_s: float = 2.0,
) -> list[ActionSpec] | None:
    """BFS to the first state satisfying the goal. Returns the action list,
    or None if unreachable within caps."""
    if is_goal(state, goal, binding):
        return []
    started = time.monotonic()
    start_key = (state.grid, state.counters)
    seen = {start_key}
    queue: deque[tuple[State, list[tuple[int, int | None, int | None]]]] = deque()
    queue.append((state, []))
    expanded = 0
    while queue:
        expanded += 1
        if expanded > node_cap:
            return None
        if expanded % 256 == 0 and time.monotonic() - started > deadline_s:
            return None
        current, path = queue.popleft()
        for action_key in _actions(current, rules, binding, legal):
            nxt, outcome = step(current, action_key, rules, binding)
            if nxt.status == "GAME_OVER" or outcome in ("blocked", "noop"):
                continue
            key = (nxt.grid, nxt.counters)
            if key in seen:
                continue
            seen.add(key)
            new_path = path + [action_key]
            if is_goal(nxt, goal, binding):
                return [
                    ActionSpec(a, x, y, source="plan", reason=f"{goal.kind}:{goal.color}")
                    for a, x, y in new_path
                ]
            queue.append((nxt, new_path))
    return None


def plan_greedy(
    state: State,
    rules: RuleSet,
    binding: Binding,
    goal: Goal,
    legal: tuple[int, ...] = (1, 2, 3, 4),
) -> ActionSpec | None:
    """One-step fallback: the action whose predicted state gets closest to
    the goal color without dying."""
    targets = [
        (i % 64, i // 64)
        for i, c in enumerate(state.grid)
        if c == goal.color
    ]
    if not targets:
        return None
    best: tuple[int, ActionSpec] | None = None
    for action_key in _actions(state, rules, binding, legal):
        nxt, outcome = step(state, action_key, rules, binding)
        if nxt.status == "GAME_OVER" or outcome in ("blocked", "noop"):
            continue
        from .rules import avatar_cells

        cells = avatar_cells(nxt.grid, binding)
        if not cells:
            continue
        dist = min(
            abs(x - tx) + abs(y - ty) for x, y in cells for tx, ty in targets
        )
        spec = ActionSpec(action_key[0], action_key[1], action_key[2],
                         source="plan-greedy", reason="distance")
        if best is None or dist < best[0]:
            best = (dist, spec)
    return best[1] if best else None
