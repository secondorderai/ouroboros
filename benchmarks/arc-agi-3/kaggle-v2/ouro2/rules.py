"""The world model: rules as data, run by a fixed interpreter.

Rules are induced by the CPU (induce.py) and never authored by the LLM, so
this interpreter is trusted code and needs no sandbox. It is total by
construction: one pass over the rules per action, push chains bounded by
the grid width, no recursion.

State is the grid itself plus consumed-item counters — exact, hashable,
and cheap enough at the planner's node cap. Painting semantics: cells the
avatar leaves are restored to the background color (games that stack items
under the avatar are represented via ``consumes``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

from .grid import CELLS, SIZE, Grid, components, most_common_color


@dataclass(frozen=True)
class Binding:
    """How raw pixels are read as entities (the representation)."""

    avatar_color: int | None = None
    background: int | None = None
    conn: int = 4

    def bg(self, g: Grid) -> int:
        return most_common_color(g) if self.background is None else self.background


@dataclass(frozen=True)
class State:
    grid: Grid
    counters: tuple[tuple[int, int], ...] = ()  # (color, consumed count), sorted
    status: str = "NOT_FINISHED"  # NOT_FINISHED | GAME_OVER

    def counter(self, color: int) -> int:
        for c, n in self.counters:
            if c == color:
                return n
        return 0

    def with_counter(self, color: int, added: int) -> "State":
        counts = dict(self.counters)
        counts[color] = counts.get(color, 0) + added
        return State(self.grid, tuple(sorted(counts.items())), self.status)


@dataclass(frozen=True)
class MoveRule:
    """Avatar movement. Subsumes push (pushable), collect (consumes) and
    death-on-contact (on_block="die")."""

    deltas: tuple[tuple[int, tuple[int, int]], ...]  # (action, (dx, dy))
    blockers: frozenset[int] = frozenset()
    pushable: frozenset[int] = frozenset()
    consumes: frozenset[int] = frozenset()
    on_block: str = "stay"  # stay | die
    slide: bool = False  # repeat the step until blocked (ice)

    kind: str = field(default="move", init=False)

    def delta_for(self, action: int) -> tuple[int, int] | None:
        for a, d in self.deltas:
            if a == action:
                return d
        return None


@dataclass(frozen=True)
class ClickRule:
    """ACTION6 recoloring. scope: cell | object | color."""

    scope: str
    mapping: tuple[tuple[int, int], ...]  # (from_color, to_color)

    kind: str = field(default="click_effect", init=False)

    def to_color(self, color: int) -> int | None:
        for src, dst in self.mapping:
            if src == color:
                return dst
        return None


@dataclass(frozen=True)
class TickRule:
    """Passive per-action translation of all objects of one color."""

    color: int
    delta: tuple[int, int]

    kind: str = field(default="tick_move", init=False)


@dataclass(frozen=True)
class HazardRule:
    """Avatar sharing a cell edge with any of these colors ends the game."""

    colors: frozenset[int]

    kind: str = field(default="hazard", init=False)


Rule = MoveRule | ClickRule | TickRule | HazardRule
RuleSet = tuple[Rule, ...]


@dataclass(frozen=True)
class Goal:
    kind: str  # reach_color | clear_color | counter_eq
    color: int
    count: int = 0


def avatar_cells(g: Grid, binding: Binding) -> frozenset[tuple[int, int]]:
    """Largest connected component of the avatar color (empty if unbound)."""
    if binding.avatar_color is None:
        return frozenset()
    return _avatar_cells_cached(g, binding.avatar_color, binding.conn)


@lru_cache(maxsize=8192)
def _avatar_cells_cached(g: Grid, color: int, conn: int) -> frozenset[tuple[int, int]]:
    # Fast path: collect the color's cells in one scan, then flood-fill only
    # among them (avatar components are tiny).
    cells = {(i % SIZE, i // SIZE) for i, c in enumerate(g) if c == color}
    if not cells:
        return frozenset()
    offsets = (
        ((1, 0), (-1, 0), (0, 1), (0, -1))
        if conn == 4
        else ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    )
    best: set[tuple[int, int]] = set()
    remaining = set(cells)
    while remaining:
        seed = remaining.pop()
        group = {seed}
        frontier = [seed]
        while frontier:
            x, y = frontier.pop()
            for dx, dy in offsets:
                p = (x + dx, y + dy)
                if p in remaining:
                    remaining.remove(p)
                    group.add(p)
                    frontier.append(p)
        if len(group) > len(best):
            best = group
    return frozenset(best)


def extract_state(g: Grid) -> State:
    return State(grid=g)


def _move_once(
    flat: bytearray,
    cells: frozenset[tuple[int, int]],
    dx: int,
    dy: int,
    rule: MoveRule,
    bg: int,
    avatar_color: int,
) -> tuple[frozenset[tuple[int, int]], list[int], bool]:
    """One movement step. Returns (new cells, consumed colors, moved?)."""
    dest = {(x + dx, y + dy) for x, y in cells}
    if any(not (0 <= x < SIZE and 0 <= y < SIZE) for x, y in dest):
        return cells, [], False
    entered = dest - cells
    entered_colors = {flat[y * SIZE + x] for x, y in entered}
    push_groups: list[frozenset[tuple[int, int]]] = []
    frontier = {p for p in entered if flat[p[1] * SIZE + p[0]] in rule.pushable}
    pushed: set[tuple[int, int]] = set()
    steps = 0
    while frontier and steps <= SIZE:
        steps += 1
        group = frozenset(frontier)
        pushed |= group
        push_groups.append(group)
        nxt = {(x + dx, y + dy) for x, y in group} - pushed - cells
        blocked = False
        for x, y in nxt:
            if not (0 <= x < SIZE and 0 <= y < SIZE):
                blocked = True
                break
            c = flat[y * SIZE + x]
            if c in rule.blockers or (c not in rule.pushable and c != bg and c not in rule.consumes):
                blocked = True
                break
        if blocked:
            return cells, [], False
        frontier = {p for p in nxt if flat[p[1] * SIZE + p[0]] in rule.pushable}
    if any(
        c in rule.blockers or (c != bg and c not in rule.consumes and c not in rule.pushable)
        for c in entered_colors
    ):
        return cells, [], False
    consumed = [
        flat[y * SIZE + x]
        for x, y in entered
        if flat[y * SIZE + x] in rule.consumes
    ]
    # Move pushed groups first (furthest groups were appended later).
    for group in reversed(push_groups):
        colors = {(x, y): flat[y * SIZE + x] for x, y in group}
        for x, y in group:
            flat[y * SIZE + x] = bg
        for (x, y), c in colors.items():
            flat[(y + dy) * SIZE + (x + dx)] = c
    for x, y in cells:
        flat[y * SIZE + x] = bg
    for x, y in dest:
        flat[y * SIZE + x] = avatar_color
    return frozenset(dest), consumed, True


def step(state: State, action_key: tuple[int, int | None, int | None],
         rules: RuleSet, binding: Binding) -> tuple[State, str]:
    """Apply one action to the model state. Returns (next state, outcome).

    Outcomes: moved | blocked | died | clicked | noop — plus status change
    to GAME_OVER on hazard contact or on_block="die".
    """
    if state.status == "GAME_OVER":
        return state, "noop"
    action, cx, cy = action_key
    flat = bytearray(state.grid)
    bg = binding.bg(state.grid)
    outcome = "noop"
    consumed: list[int] = []

    if action == 6 and cx is not None and cy is not None:
        target = flat[cy * SIZE + cx]
        for rule in rules:
            if isinstance(rule, ClickRule):
                dst = rule.to_color(target)
                if dst is None:
                    continue
                if rule.scope == "cell":
                    flat[cy * SIZE + cx] = dst
                elif rule.scope == "object":
                    for obj in components(bytes(flat), colors={target}, background=bg):
                        if (cx, cy) in obj.cells:
                            for x, y in obj.cells:
                                flat[y * SIZE + x] = dst
                            break
                else:  # color
                    for i in range(CELLS):
                        if flat[i] == target:
                            flat[i] = dst
                outcome = "clicked"
                break

    move_rule = next((r for r in rules if isinstance(r, MoveRule)), None)
    if move_rule is not None and binding.avatar_color is not None:
        delta = move_rule.delta_for(action)
        if delta is not None:
            cells = avatar_cells(bytes(flat), binding)
            if cells:
                moved_any = False
                while True:
                    cells2, eaten, moved = _move_once(
                        flat, cells, delta[0], delta[1], move_rule, bg,
                        binding.avatar_color,
                    )
                    consumed.extend(eaten)
                    if not moved:
                        break
                    moved_any = True
                    cells = cells2
                    if not move_rule.slide:
                        break
                if moved_any:
                    outcome = "moved"
                elif outcome == "noop":
                    if move_rule.on_block == "die":
                        return State(bytes(flat), state.counters, "GAME_OVER"), "died"
                    outcome = "blocked"

    for rule in rules:
        if isinstance(rule, TickRule):
            dx, dy = rule.delta
            objs = components(bytes(flat), colors={rule.color}, background=bg)
            for obj in objs:
                dest = {(x + dx, y + dy) for x, y in obj.cells}
                if any(not (0 <= x < SIZE and 0 <= y < SIZE) for x, y in dest):
                    continue
                if any(
                    flat[y * SIZE + x] not in (bg, rule.color)
                    for x, y in dest - obj.cells
                ):
                    continue
                for x, y in obj.cells:
                    flat[y * SIZE + x] = bg
                for x, y in dest:
                    flat[y * SIZE + x] = rule.color

    next_state = State(bytes(flat), state.counters, state.status)
    for color in consumed:
        next_state = next_state.with_counter(color, 1)

    hazard = next((r for r in rules if isinstance(r, HazardRule)), None)
    if hazard is not None and binding.avatar_color is not None:
        cells = avatar_cells(next_state.grid, binding)
        g = next_state.grid
        for x, y in cells:
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < SIZE and 0 <= ny < SIZE and g[ny * SIZE + nx] in hazard.colors:
                    return State(g, next_state.counters, "GAME_OVER"), "died"

    return next_state, outcome


def is_goal(state: State, goal: Goal, binding: Binding) -> bool:
    g = state.grid
    if goal.kind == "clear_color":
        return goal.color not in g
    if goal.kind == "counter_eq":
        return state.counter(goal.color) >= goal.count
    if goal.kind == "reach_color":
        if goal.color not in g:
            return True  # consumed/painted over the last target cell
        for x, y in avatar_cells(g, binding):
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < SIZE and 0 <= ny < SIZE and g[ny * SIZE + nx] == goal.color:
                    return True
        return False
    return False
