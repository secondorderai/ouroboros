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
        # Milk-the-productive-click: consecutive same-click changes
        self.last_click: tuple[int, int] | None = None
        self.last_click_streak = 0
        self.tried: dict[str, set[tuple[int, int | None, int | None]]] = {}
        # LRU is keyed per (state, action): per-state rotor-router sweeps
        # provably cover the reachable state graph, while a global LRU would
        # round-robin up/down/left/right into a net-zero loop.
        self.last_used: dict[tuple[str, tuple[int, int | None, int | None]], int] = {}
        self.clock = 0
        self.color_stats: dict[int, list[int]] = {}  # color -> [changes, tries]
        self.cell_stats: dict[tuple[int, int], list[int]] = {}  # (x,y) -> same

    def note_result(
        self,
        state_key: str,
        action: ActionSpec,
        changed: bool,
        grid: Grid | None = None,
        novel: bool = True,
    ) -> None:
        self.tried.setdefault(state_key, set()).add(action.key())
        if not changed and not action.is_reset():
            self.noop_bans.add((state_key, action.key()))
        if action.action == 6 and action.x is not None:
            # Milk only while the click produces NOVEL states: a changing-
            # but-revisiting board is an oscillating toggle (the cn04
            # reward-hack), not progress.
            productive = changed and novel
            if productive and self.last_click == (action.x, action.y):
                self.last_click_streak += 1
            elif productive:
                self.last_click = (action.x, action.y)
                self.last_click_streak = 1
            else:
                self.last_click = None
                self.last_click_streak = 0
        # Global click priors: most targets are inert in EVERY state, and
        # per-state bans alone re-pay the whole sweep after each board
        # change. Learn per-cell and per-color outcomes once, globally.
        if action.action == 6 and grid is not None and action.x is not None:
            color = grid[action.y * 64 + action.x]
            cs = self.color_stats.setdefault(color, [0, 0])
            cs[0] += 1 if changed else 0
            cs[1] += 1
            cell = self.cell_stats.setdefault((action.x, action.y), [0, 0])
            cell[0] += 1 if changed else 0
            cell[1] += 1

    def ban(self, state_key: str, action: ActionSpec) -> None:
        """Permanent ban (deaths): never repeat this exact mistake."""
        self.noop_bans.add((state_key, action.key()))
        self.tried.setdefault(state_key, set()).add(action.key())

    def _click_targets(self, g: Grid) -> list[tuple[int, int]]:
        """Centroids round-robined across colors: a game's live controls are
        often one color among many inert ones, and a size-ranked cap can
        exclude that color entirely (ft09's color-9 tiles hid behind 24
        larger inert objects)."""
        by_color: dict[int, list[tuple[int, int]]] = {}
        for o in components(g):
            by_color.setdefault(o.color, []).append(o.centroid)
        out: list[tuple[int, int]] = []
        round_idx = 0
        # Cover ALL components (cap well above real boards' counts): ft09
        # has 20 same-color tiles where only the central board ones respond —
        # a small cap starved the list before reaching them.
        while len(out) < 96:
            added = False
            for color in sorted(by_color):
                targets = by_color[color]
                if round_idx < len(targets):
                    out.append(targets[round_idx])
                    added = True
                    if len(out) >= 96:
                        break
            if not added:
                break
            round_idx += 1
        # Cell-precision targets for small pattern boards: paint/copy games
        # respond to individual CELLS, not object centroids (the audit's
        # "center-of-object only" blind spot). Enumerate cells of up to two
        # mid-sized objects.
        boards = [
            o for o in components(g) if 9 <= o.size <= 49 and o.width >= 3 and o.height >= 3
        ][:2]
        for o in boards:
            for x, y in sorted(o.cells):
                if len(out) >= 140:
                    break
                out.append((x, y))
        return out

    def _ranked_clicks(self, g: Grid) -> list[tuple[int, int]]:
        """Click targets ordered by learned promise: colors that have
        produced changes first (optimistic prior for the untried), then
        least-tried cells; cells proven inert twice are dropped."""
        scored = []
        fallback = []
        for x, y in self._click_targets(g):
            color = g[y * 64 + x]
            ch, tr = self.color_stats.get(color, (0, 0))
            cch, ctr = self.cell_stats.get((x, y), (0, 0))
            fallback.append((x, y))
            if ctr >= 2 and cch == 0:
                continue  # globally inert cell
            prior = (ch + 1) / (tr + 2)
            scored.append((-prior, ctr, x, y))
        if not scored:
            return fallback
        scored.sort()
        return [(x, y) for _, _, x, y in scored]

    def next(self, g: Grid, legal: list[int]) -> ActionSpec:
        self.clock += 1
        key = grid_key(g)
        tried = self.tried.get(key, set())
        # Milk a productive click: a click that keeps changing the board is
        # doing WORK (counters, fills, cycles) — repeat it until it stops
        # (V1's paired-control and large-click replay, generalized).
        if (
            6 in legal
            and self.last_click is not None
            and 1 <= self.last_click_streak < 24
        ):
            x, y = self.last_click
            if (key, (6, x, y)) not in self.noop_bans:
                self.last_used[(key, (6, x, y))] = self.clock
                return ActionSpec(6, x, y, source="explore", reason="milk click")
        for action in SIMPLE_ACTIONS:
            if action in legal:
                k = (action, None, None)
                if k not in tried and (key, k) not in self.noop_bans:
                    self.last_used[(key, k)] = self.clock
                    return ActionSpec(action, source="explore", reason="untried action")
        if 6 in legal:
            for x, y in self._ranked_clicks(g):
                k = (6, x, y)
                if k not in tried and (key, k) not in self.noop_bans:
                    self.last_used[(key, k)] = self.clock
                    return ActionSpec(6, x, y, source="explore", reason="untried click")
        candidates: list[tuple[int, tuple[int, int | None, int | None]]] = []
        for action in legal:
            if action == 0:
                continue
            if action == 6:
                for x, y in self._ranked_clicks(g):
                    k = (6, x, y)
                    if (key, k) not in self.noop_bans:
                        candidates.append((self.last_used.get((key, k), 0), k))
            else:
                k = (action, None, None)
                if (key, k) not in self.noop_bans:
                    candidates.append((self.last_used.get((key, k), 0), k))
        if not candidates:  # everything banned here: retry oldest anyway,
            # clicks included — a state with only banned candidates must not
            # become a graveyard the run spins in.
            for action in legal:
                if action == 0:
                    continue
                if action == 6:
                    for x, y in self._click_targets(g):
                        k = (6, x, y)
                        candidates.append((self.last_used.get((key, k), 0), k))
                else:
                    k = (action, None, None)
                    candidates.append((self.last_used.get((key, k), 0), k))
        if not candidates:
            return ActionSpec(0, source="explore", reason="no legal actions")
        candidates.sort()
        _, k = candidates[0]
        self.last_used[(key, k)] = self.clock
        return ActionSpec(k[0], k[1], k[2], source="explore", reason="lru sweep")
