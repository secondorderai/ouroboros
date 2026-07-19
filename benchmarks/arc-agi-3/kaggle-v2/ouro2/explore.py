"""The fallback explorer — the floor beneath the world-model path.

One coherent policy instead of V1's nine solvers: untried simple actions
first, then untried salient clicks, then the least-recently-used legal
action. No-op (state, action) pairs are banned permanently — wall memory
persists across level resets and plays (V1 wiped it and re-paid the cost
after every death).
"""
from __future__ import annotations

from .grid import Grid, components, grid_key
from .timeline import ActionSpec

SIMPLE_ACTIONS = (1, 2, 3, 4, 5, 7)


class Explorer:
    def __init__(self) -> None:
        self.noop_bans: set[tuple[str, tuple[int, int | None, int | None]]] = set()
        self.tried: dict[str, set[tuple[int, int | None, int | None]]] = {}
        # LRU is keyed per (state, action): per-state rotor-router sweeps
        # provably cover the reachable state graph, while a global LRU would
        # round-robin up/down/left/right into a net-zero loop.
        self.last_used: dict[tuple[str, tuple[int, int | None, int | None]], int] = {}
        self.clock = 0

    def note_result(self, state_key: str, action: ActionSpec, changed: bool) -> None:
        self.tried.setdefault(state_key, set()).add(action.key())
        if not changed and not action.is_reset():
            self.noop_bans.add((state_key, action.key()))

    def _click_targets(self, g: Grid) -> list[tuple[int, int]]:
        return [o.centroid for o in components(g)[:24]]

    def next(self, g: Grid, legal: list[int]) -> ActionSpec:
        self.clock += 1
        key = grid_key(g)
        tried = self.tried.get(key, set())
        for action in SIMPLE_ACTIONS:
            if action in legal:
                k = (action, None, None)
                if k not in tried and (key, k) not in self.noop_bans:
                    self.last_used[(key, k)] = self.clock
                    return ActionSpec(action, source="explore", reason="untried action")
        if 6 in legal:
            for x, y in self._click_targets(g):
                k = (6, x, y)
                if k not in tried and (key, k) not in self.noop_bans:
                    self.last_used[(key, k)] = self.clock
                    return ActionSpec(6, x, y, source="explore", reason="untried click")
        candidates: list[tuple[int, tuple[int, int | None, int | None]]] = []
        for action in legal:
            if action == 0:
                continue
            if action == 6:
                for x, y in self._click_targets(g):
                    k = (6, x, y)
                    if (key, k) not in self.noop_bans:
                        candidates.append((self.last_used.get((key, k), 0), k))
            else:
                k = (action, None, None)
                if (key, k) not in self.noop_bans:
                    candidates.append((self.last_used.get((key, k), 0), k))
        if not candidates:  # everything banned here: retry oldest anyway
            for action in legal:
                if action != 0:
                    k = (action, None, None)
                    candidates.append((self.last_used.get((key, k), 0), k))
        if not candidates:
            return ActionSpec(0, source="explore", reason="no legal actions")
        candidates.sort()
        _, k = candidates[0]
        self.last_used[(key, k)] = self.clock
        return ActionSpec(k[0], k[1], k[2], source="explore", reason="lru sweep")
