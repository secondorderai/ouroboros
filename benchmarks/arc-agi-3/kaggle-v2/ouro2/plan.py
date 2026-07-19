"""Search inside the induced model. Pure search: execution and
predicted-vs-observed checking belong to the director.

States are (grid bytes, counters) — exact and hashable. At the node cap
(default 20k) full-grid states cost tens of milliseconds, which buys the
simplicity of never reconstructing state from a factored encoding.
"""
from __future__ import annotations

import time
from collections import deque

from .grid import Grid, components, diff as _diff, most_common_color
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


def plan_frontier(
    state: State,
    rules: RuleSet,
    binding: Binding,
    seen: set[str],
    legal: tuple[int, ...] = (1, 2, 3, 4),
    node_cap: int = 20000,
    deadline_s: float = 1.0,
    max_len: int = 16,
    volatile: frozenset[int] = frozenset(),
    depleting: frozenset[int] = frozenset(),
    banned: set | None = None,
) -> list[ActionSpec] | None:
    """BFS inside the model to the nearest state NOT seen in reality yet.

    This is directed exploration: before any goal is known (level 0, the
    lab), a verified move-model plus wall knowledge turns exploration from
    a rotor-router walk into shortest-path frontier probing.
    """
    from .grid import masked_key

    started = time.monotonic()
    start_key = (state.grid, state.counters)
    seen_model = {start_key}
    queue: deque[tuple[State, list[tuple[int, int | None, int | None]]]] = deque()
    queue.append((state, []))
    expanded = 0
    avatar = binding.avatar_color
    bg = binding.bg(state.grid)
    move = next((r for r in rules if isinstance(r, MoveRule)), None)
    start_masked = _mask(state.grid, volatile, depleting, keep=avatar)
    # rank: 0 = interaction novelty, 1 = untested-block probe, 2 = reposition
    found: list[tuple[int, int, list[tuple[int, int | None, int | None]]]] = []
    stop_depth = max_len
    while queue:
        expanded += 1
        if expanded > node_cap:
            break
        if expanded % 256 == 0 and time.monotonic() - started > deadline_s:
            break
        current, path = queue.popleft()
        if len(path) >= min(stop_depth, max_len):
            continue
        for action_key in _actions(current, rules, binding, legal):
            nxt, outcome = step(current, action_key, rules, binding)
            if nxt.status == "GAME_OVER":
                continue
            if outcome in ("blocked", "noop"):
                # The model may be wrong about this block: a color it never
                # SAW block (absent from learned blockers) is an untested
                # assumption — the highest-information experiment when plain
                # novelty runs dry (a sokoban box was "blocked" from the
                # target cell only by default classification).
                if (
                    move is not None
                    and outcome == "blocked"
                    and avatar is not None
                ):
                    entered = _entered_colors(current, action_key, move, binding)
                    already = banned is not None and (
                        masked_key(
                            _mask(current.grid, volatile, depleting, keep=avatar),
                            frozenset(),
                        ),
                        action_key,
                    ) in banned
                    if entered and not (entered & move.blockers) and not already:
                        found.append((1, len(path) + 1, path + [action_key]))
                continue
            key = (nxt.grid, nxt.counters)
            if key in seen_model:
                continue
            seen_model.add(key)
            new_path = path + [action_key]
            if masked_key(_mask(nxt.grid, volatile, depleting, keep=avatar), frozenset()) not in seen:
                # Interactions (a non-avatar object changed, judged on the
                # MASKED grids so tickers don't pollute) outrank walking.
                interaction = any(
                    old not in (avatar, bg) or new not in (avatar, bg)
                    for _, _, old, new in _diff(start_masked, _mask(nxt.grid, volatile, depleting, keep=avatar))
                )
                found.append((0 if interaction else 2, len(new_path), new_path))
                if interaction:
                    stop_depth = len(new_path)
                elif stop_depth == max_len:
                    stop_depth = len(new_path) + 4
                if len(found) >= 16:
                    queue.clear()
                    break
                continue
            queue.append((nxt, new_path))
    if not found:
        return None
    found.sort(key=lambda f: (f[0], f[1]))
    best = found[0][2]
    return [
        ActionSpec(a, x, y, source="plan-frontier", reason="novel state")
        for a, x, y in best
    ]


def _mask(
    g: Grid,
    volatile: frozenset[int],
    depleting: frozenset[int] = frozenset(),
    keep: int | None = None,
) -> Grid:
    from .induce import masked

    return masked(g, volatile, depleting, keep=keep)


def _entered_colors(state: State, action_key, move: MoveRule, binding: Binding):
    from .rules import avatar_cells

    delta = move.delta_for(action_key[0])
    if delta is None:
        return frozenset()
    cells = avatar_cells(state.grid, binding)
    bgc = binding.bg(state.grid)
    out = set()
    for x, y in cells:
        nx, ny = x + delta[0], y + delta[1]
        if (nx, ny) not in cells and 0 <= nx < 64 and 0 <= ny < 64:
            c = state.grid[ny * 64 + nx]
            if c not in (bgc, binding.avatar_color):
                out.add(c)
    return frozenset(out)


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
