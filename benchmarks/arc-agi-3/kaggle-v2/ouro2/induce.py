"""CPU rule induction: exact transition diffs -> parameterized rules.

The 4B never authors rules; it may only rank the candidates generated
here. Candidate generation is evidence-directed: a rigid translation of
color c by (dx, dy) admits only a move/tick rule with that delta; a
localized recolor admits only a click rule with that mapping. Evaluation
replays the whole timeline through the interpreter (Schema's
run_backtest): certification and prequential scoring are the same pass.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .grid import Grid, components, diff, most_common_color
from .rules import (
    Binding,
    ClickRule,
    Goal,
    HazardRule,
    MoveRule,
    Rule,
    RuleSet,
    State,
    TickRule,
    avatar_cells,
    is_goal,
    step,
)
from .timeline import Timeline, Transition

SIMPLE_MOVE_ACTIONS = (1, 2, 3, 4)


def _cells_of(g: Grid, color: int) -> frozenset[tuple[int, int]]:
    return frozenset((i % 64, i // 64) for i, c in enumerate(g) if c == color)


def translated(before: Grid, after: Grid, color: int) -> tuple[int, int] | None:
    """(dx, dy) if every cell of ``color`` rigidly translated, else None.

    A rigid translation maps the lexicographic minimum of the set to the
    minimum of the image, so exactly one candidate delta needs checking —
    O(n), which matters because callers probe every changed color
    (including ~4000-cell backgrounds).
    """
    a = _cells_of(before, color)
    b = _cells_of(after, color)
    if not a or len(a) != len(b) or a == b or len(a) > 512:
        return None
    ax, ay = min(a)
    bx, by = min(b)
    dx, dy = bx - ax, by - ay
    if (dx, dy) != (0, 0) and {(x + dx, y + dy) for x, y in a} == b:
        return (dx, dy)
    return None


# ---------------------------------------------------------------------------
# Volatility mask: cells that keep changing regardless of what the rules
# explain (energy bars, timers, animations). Excluded from model comparison,
# per-step verification and state keys — Schema's observation that a model
# is "right" when mispredictions collapse, made cell-local.


def volatile_cells(timeline: Timeline, sample: int = 200) -> frozenset[int]:
    counts = [0] * 4096
    n = 0
    for t in timeline.transitions[-sample:]:
        if t.before is None or t.after is None or t.action.is_reset() or t.level_up:
            continue
        n += 1
        for x, y, _, _ in diff(t.before, t.after):
            counts[y * 64 + x] += 1
    if n < 12:
        return frozenset()
    # Only near-every-transition churn qualifies (energy bars, timers,
    # animations). Gameplay cells an oscillating walk revisits stay firmly
    # below this — masking them would blind the executor where it matters.
    threshold = max(8, int(0.45 * n))
    return frozenset(i for i, c in enumerate(counts) if c >= threshold)


def masked(
    g: Grid,
    volatile: frozenset[int],
    depleting: frozenset[int] = frozenset(),
    keep: int | None = None,
) -> Grid:
    """Zero volatile cells and depleting-color cells — except cells holding
    ``keep`` (the avatar): its position is the state."""
    if not volatile and not depleting:
        return g
    flat = bytearray(g)
    for i in volatile:
        if keep is None or flat[i] != keep:
            flat[i] = 0
    if depleting:
        for i in range(4096):
            if flat[i] in depleting and flat[i] != keep:
                flat[i] = 0
    return bytes(flat)


def depleting_colors(timeline: Timeline) -> frozenset[int]:
    """Colors whose cell count only ever falls within a level (energy bars,
    progress strips). They deplete on every action — unpredictable by any
    mechanic rule and poisonous to state identity — so they are masked at
    the COLOR level (their cells move as the bar drains, so per-cell
    frequency masking cannot see them)."""
    from collections import Counter as C

    decreases: C = C()
    increases: C = C()
    for seg in timeline.levels():
        prev: dict[int, int] | None = None
        for t in seg.transitions:
            if t.before is None or t.after is None or t.action.is_reset():
                continue
            counts = C(t.after)
            if prev is not None:
                for color in set(prev) | set(counts):
                    d = counts.get(color, 0) - prev.get(color, 0)
                    if d < 0:
                        decreases[color] += 1
                    elif d > 0:
                        increases[color] += 1
            prev = dict(counts)
    return frozenset(
        c for c, n in decreases.items() if n >= 5 and increases.get(c, 0) == 0
    )


# ---------------------------------------------------------------------------
# Binding (representation) induction


def _consistent_majorities(by_action: dict) -> dict:
    """Per action, the majority delta — kept only when it truly dominates.

    A controlled object answers the same action with the same delta almost
    every time; a phase-correlated ticker (bouncing patroller) splits its
    votes ~50/50 and must not qualify."""
    out = {}
    for action, counter in by_action.items():
        delta, n = counter.most_common(1)[0]
        total = sum(counter.values())
        if total >= 2 and n / total >= 0.7:
            out[action] = (delta, n)
    return out


def _axis_jump(delta: tuple[int, int]) -> bool:
    """A plausible move delta: along one axis, 1-8 cells (ls20's avatar
    jumps 5 cells per press)."""
    dx, dy = delta
    return (dx == 0) != (dy == 0) and abs(dx) + abs(dy) <= 8


def rebind(timeline: Timeline) -> Binding:
    """Pick the avatar color: the color whose translation is a FUNCTION of
    the action. A passive ticker moves identically whatever you press; the
    controlled object answers different actions with different deltas.
    This is the representation-revision entry point — called fresh on every
    (re)induction."""
    per_color: dict[int, dict[int, Counter]] = defaultdict(lambda: defaultdict(Counter))
    for t in _informative(timeline):
        if t.before is None or t.after is None or t.action.action not in SIMPLE_MOVE_ACTIONS:
            continue
        changed = diff(t.before, t.after)
        if not changed:
            continue
        for color in {old for _, _, old, _ in changed}:
            delta = translated(t.before, t.after, color)
            if delta is not None and _axis_jump(delta):
                per_color[color][t.action.action][delta] += 1
    best_color = None
    best_score = 0
    for color, by_action in per_color.items():
        majority = _consistent_majorities(by_action)
        distinct = {delta for delta, _ in majority.values()}
        if len(majority) < 1 or (len(majority) >= 2 and len(distinct) < 2):
            continue  # constant delta across actions: a ticker, not an avatar
        score = sum(n for _, n in majority.values())
        if score > best_score:
            best_color, best_score = color, score
    # Loose pass (representation revision): multi-color sprites never
    # translate rigidly per color — vote on CENTROID displacement with
    # size tolerance instead (ls20's block with a mutating indicator).
    strict_winner = best_color
    per_color = defaultdict(lambda: defaultdict(Counter))
    for t in _informative(timeline):
        if t.before is None or t.after is None or t.action.action not in SIMPLE_MOVE_ACTIONS:
            continue
        for color in {old for _, _, old, _ in diff(t.before, t.after)}:
            a = _cells_of(t.before, color)
            b = _cells_of(t.after, color)
            if not a or not b or len(a) > 512 or abs(len(a) - len(b)) > max(2, len(a) // 4):
                continue
            ax = sum(x for x, _ in a) / len(a)
            ay = sum(y for _, y in a) / len(a)
            bx = sum(x for x, _ in b) / len(b)
            by = sum(y for _, y in b) / len(b)
            delta = (round(bx - ax), round(by - ay))
            if _axis_jump(delta):
                per_color[color][t.action.action][delta] += 1
    for color, by_action in per_color.items():
        majority = _consistent_majorities(by_action)
        distinct = {delta for delta, _ in majority.values()}
        if len(majority) < 1 or (len(majority) >= 2 and len(distinct) < 2):
            continue
        score = sum(n for _, n in majority.values())
        if strict_winner is None and score > best_score:
            best_color, best_score = color, score
    if best_color is None:
        return Binding()
    companions: Counter = Counter()
    moves = 0
    for t in _informative(timeline):
        if t.before is None or t.after is None or t.action.action not in SIMPLE_MOVE_ACTIONS:
            continue
        # Loose delta (centroid displacement): the sprite's indicator part
        # mutates between frames, so exact-shape translation rarely holds.
        a = _cells_of(t.before, best_color)
        b = _cells_of(t.after, best_color)
        if not a or not b or abs(len(a) - len(b)) > max(2, len(a) // 4):
            continue
        ax = sum(x for x, _ in a) / len(a); ay = sum(y for _, y in a) / len(a)
        bx = sum(x for x, _ in b) / len(b); by = sum(y for _, y in b) / len(b)
        delta = (round(bx - ax), round(by - ay))
        if not _axis_jump(delta):
            continue
        moves += 1
        av = _cells_of(t.before, best_color)
        near = {
            (x + dx, y + dy)
            for x, y in av
            for dx in (-2, -1, 0, 1, 2)
            for dy in (-2, -1, 0, 1, 2)
        }
        changed = diff(t.before, t.after)
        dx, dy = delta
        for color in {old for _, _, old, _ in changed}:
            if color == best_color:
                continue
            # Cell-local: the same color may exist elsewhere on the board
            # (ls20's goal room shares the sprite's color), so whole-color
            # translation can never match — look for c-cells NEAR the avatar
            # that vanish and reappear shifted by the avatar's delta.
            gone = {
                (x, y) for x, y, old, new in changed if old == color and new != color
            }
            came = {
                (x, y) for x, y, old, new in changed if new == color and old != color
            }
            shifted = {(x + dx, y + dy) for x, y in gone}
            if (
                gone
                and gone & near
                and len(shifted & came) >= max(2, len(gone) // 2)
            ):
                companions[color] += 1
    extra = frozenset(
        c for c, n in companions.items() if moves >= 3 and n >= 0.6 * moves
    )
    return Binding(avatar_color=best_color, avatar_extra=extra)


# ---------------------------------------------------------------------------
# Candidate generation


def candidates_from(t: Transition, binding: Binding) -> list[Rule]:
    """Rules consistent with this single transition (dedup'd later)."""
    if t.before is None or t.after is None or t.action.is_reset():
        return []
    changed = diff(t.before, t.after)
    if not changed:
        return []
    out: list[Rule] = []
    action = t.action.action
    moved_colors: dict[int, tuple[int, int]] = {}
    for color in {old for _, _, old, _ in changed} | {new for _, _, _, new in changed}:
        delta = translated(t.before, t.after, color)
        if delta is not None:
            moved_colors[color] = delta

    if action in SIMPLE_MOVE_ACTIONS and binding.avatar_color in moved_colors:
        delta = moved_colors[binding.avatar_color]
        # The color vacated cells actually became — maze floors are NOT the
        # global background (most-common is often the WALL color).
        floors = Counter(
            new
            for _, _, old, new in changed
            if old == binding.avatar_color and new != binding.avatar_color
        )
        floor = floors.most_common(1)[0][0] if floors else None
        out.append(MoveRule(deltas=((action, delta),), floor=floor))
        # Colors that vanished where the avatar landed -> consumable.
        av_after = _cells_of(t.after, binding.avatar_color)
        eaten = {
            old
            for x, y, old, new in changed
            if new == binding.avatar_color and old not in (binding.avatar_color,)
            and old != binding.bg(t.before) and (x, y) in av_after
        }
        # A color that moved with the same delta AND stood in the cells the
        # avatar entered -> push. (Same-delta alone votes coincidental
        # co-movers — a patrolling enemy — into "pushable".)
        av_before = _cells_of(t.before, binding.avatar_color)
        entered_cells = {
            (x + delta[0], y + delta[1]) for x, y in av_before
        } - av_before
        pushed = {
            c for c, d in moved_colors.items()
            if c != binding.avatar_color and d == delta
            and entered_cells & _cells_of(t.before, c)
        }
        if eaten:
            out.append(MoveRule(deltas=((action, delta),), consumes=frozenset(eaten)))
        if pushed:
            out.append(MoveRule(deltas=((action, delta),), pushable=frozenset(pushed)))

    if action == 6 and t.action.x is not None:
        cx, cy = t.action.x, t.action.y
        target = t.before[cy * 64 + cx]
        recolors = {(old, new) for _, _, old, new in changed}
        if len(recolors) == 1:
            old, new = next(iter(recolors))
            if old == target:
                n_changed = len(changed)
                target_cells = _cells_of(t.before, old)
                clicked_obj = next(
                    (
                        o
                        for o in components(
                            t.before, colors={old}, background=binding.bg(t.before)
                        )
                        if (cx, cy) in o.cells
                    ),
                    None,
                )
                if n_changed == 1 and (cx, cy) == next(iter({(x, y) for x, y, _, _ in changed})):
                    out.append(ClickRule(scope="cell", mapping=((old, new),)))
                if clicked_obj is not None and {(x, y) for x, y, _, _ in changed} == set(
                    clicked_obj.cells
                ):
                    out.append(ClickRule(scope="object", mapping=((old, new),)))
                if {(x, y) for x, y, _, _ in changed} == set(target_cells):
                    out.append(ClickRule(scope="color", mapping=((old, new),)))

    for color, delta in moved_colors.items():
        if color != binding.avatar_color and abs(delta[0]) + abs(delta[1]) >= 1:
            out.append(TickRule(color=color, delta=delta))

    if t.state_after == "GAME_OVER" and binding.avatar_color is not None:
        cells = avatar_cells(t.after, binding) or avatar_cells(t.before, binding)
        g = t.after
        adjacent = set()
        bg = binding.bg(g)
        for x, y in cells:
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < 64 and 0 <= ny < 64:
                    c = g[ny * 64 + nx]
                    if c not in (bg, binding.avatar_color):
                        adjacent.add(c)
        if adjacent:
            out.append(HazardRule(colors=frozenset(adjacent)))
    return out


# ---------------------------------------------------------------------------
# Evaluation (backtest) and specialization


@dataclass
class Report:
    support: int = 0
    contradictions: int = 0
    matches_by_level: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    misses_by_level: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    counterexamples: list[Transition] = field(default_factory=list)

    def healthy_for(self, level: int, max_misses: int = 4) -> bool:
        return (
            self.support > 0
            and self.misses_by_level.get(level, 0) <= max_misses
        )


EVALUATE_WINDOW = 160


def _informative(timeline: Timeline) -> list[Transition]:
    """Bounded backtest set: the recent window plus every level-up-adjacent
    transition (they carry the goal evidence)."""
    ts = timeline.transitions
    if len(ts) <= EVALUATE_WINDOW:
        return list(ts)
    keep = ts[-EVALUATE_WINDOW:]
    extras = [t for t in ts[:-EVALUATE_WINDOW] if t.level_up]
    return extras + keep


def evaluate(
    rules: RuleSet,
    timeline: Timeline,
    binding: Binding,
    volatile: frozenset[int] = frozenset(),
    depleting: frozenset[int] = frozenset(),
) -> Report:
    """Replay recorded transitions through the interpreter and compare grids
    exactly outside the volatility mask (level-up frames excluded: the env
    swaps the board). Bounded by EVALUATE_WINDOW to keep re-induction
    affordable."""
    report = Report()
    for t in _informative(timeline):
        if (
            t.before is None
            or t.after is None
            or t.action.is_reset()
            or t.level_up
            or t.state_after == "GAME_OVER"
        ):
            continue
        predicted, _ = step(State(t.before), t.action.key(), rules, binding)
        pg = masked(predicted.grid, volatile, depleting)
        ag = masked(t.after, volatile, depleting)
        if pg == ag or len(diff(pg, ag)) <= 2:
            report.support += 1
            report.matches_by_level[t.level] += 1
        else:
            report.contradictions += 1
            report.misses_by_level[t.level] += 1
            if len(report.counterexamples) < 16:
                report.counterexamples.append(t)
    return report


def specialize(rule: MoveRule, counterexample: Transition, binding: Binding) -> list[MoveRule]:
    """Refine a move rule against one counterexample (guard addition only,
    depth is bounded by the caller)."""
    out: list[MoveRule] = []
    t = counterexample
    if t.before is None or t.after is None:
        return out
    delta = rule.delta_for(t.action.action)
    if delta is None:
        return out
    cells = avatar_cells(t.before, binding)
    if not cells:
        return out
    entered = {(x + delta[0], y + delta[1]) for x, y in cells} - cells
    entered_colors = {
        t.before[y * 64 + x]
        for x, y in entered
        if 0 <= x < 64 and 0 <= y < 64
    }
    moved = translated(t.before, t.after, binding.avatar_color or -1) is not None
    unchanged = t.before == t.after
    if not unchanged:
        av = binding.avatar_color
        unchanged = (
            av is not None
            and avatar_cells(t.before, binding) == avatar_cells(t.after, binding)
        )
    if unchanged and entered_colors:
        # Predicted a move but nothing happened: entered color blocks.
        for c in entered_colors - rule.blockers - {binding.bg(t.before)}:
            out.append(
                MoveRule(
                    deltas=rule.deltas,
                    blockers=rule.blockers | {c},
                    pushable=rule.pushable,
                    consumes=rule.consumes,
                    on_block=rule.on_block,
                    slide=rule.slide,
                )
            )
    elif moved and entered_colors - rule.consumes - {binding.bg(t.before)}:
        # Moved through a color we thought would block: mark consumable.
        for c in entered_colors - rule.consumes - {binding.bg(t.before)} - rule.blockers:
            out.append(
                MoveRule(
                    deltas=rule.deltas,
                    blockers=rule.blockers,
                    pushable=rule.pushable,
                    consumes=rule.consumes | {c},
                    on_block=rule.on_block,
                    slide=rule.slide,
                )
            )
    return out


# ---------------------------------------------------------------------------
# Goal inference


def infer_goal_candidates(timeline: Timeline, binding: Binding) -> list[Goal]:
    """Predicates true at every level-up and false at non-level-up states
    of the same level (negative examples are what make this sound). The
    consistent list is exposed so an oracle can break ties."""
    level_ups = [
        t
        for t in timeline.transitions
        if t.level_up and t.before is not None and t.after is not None
    ]
    if not level_ups:
        return []
    candidates: list[Goal] = []
    first = level_ups[0]
    bg = binding.bg(first.before)
    if binding.avatar_color is not None:
        cells = avatar_cells(first.before, binding)
        adjacent = set()
        for x, y in cells:
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < 64 and 0 <= ny < 64:
                    c = first.before[ny * 64 + nx]
                    if c not in (bg, binding.avatar_color):
                        adjacent.add(c)
        candidates.extend(Goal("reach_color", c) for c in adjacent)
    before_counts = Counter(first.before)
    candidates.extend(
        Goal("clear_color", c)
        for c in before_counts
        if c not in (bg, binding.avatar_color) and before_counts[c] <= 4
    )
    # counter_eq: colors fully consumed over the course of the level.
    for seg in timeline.levels():
        if not seg.completed or not seg.transitions:
            continue
        start = seg.transitions[0].before
        end = seg.transitions[-1].after
        if start is None or end is None:
            continue
        start_counts = Counter(start)
        end_counts = Counter(end)
        for c in start_counts:
            if c in (bg, binding.avatar_color):
                continue
            gone = start_counts[c] - end_counts.get(c, 0)
            if gone > 0 and end_counts.get(c, 0) == 0:
                candidates.append(Goal("counter_eq", c, count=gone))
        break

    def consistent(goal: Goal) -> bool:
        # The state satisfying the predicate is unobservable (the board swaps
        # to the next level on completion), so soundness comes from the
        # NEGATIVE examples: the predicate must be false at every earlier
        # state of each level segment.
        for seg in timeline.levels():
            for t in seg.transitions[:-1]:
                if t.before is None:
                    continue
                if goal.kind in ("reach_color", "clear_color") and is_goal(
                    State(t.before), goal, binding
                ):
                    return False
        return True

    consistent_goals = [g for g in candidates if consistent(g)]
    return consistent_goals or (candidates[:1] if candidates else [])


def infer_goal(timeline: Timeline, binding: Binding) -> Goal | None:
    goals = infer_goal_candidates(timeline, binding)
    return goals[0] if goals else None


# ---------------------------------------------------------------------------
# Orchestration


@dataclass
class Model:
    binding: Binding
    rules: RuleSet
    report: Report
    goal: Goal | None
    volatile: frozenset[int] = frozenset()
    depleting: frozenset[int] = frozenset()

    def masked(self, g: Grid) -> Grid:
        return masked(
            g, self.volatile, self.depleting, keep=self.binding.avatar_color
        )

    def healthy_for(self, level: int) -> bool:
        return bool(self.rules) and self.report.healthy_for(level)


def induce(timeline: Timeline, max_specialize_rounds: int = 4) -> Model:
    """Full (re)induction from scratch over the timeline. Time cost is
    bounded by the caller's cadence, not internally."""
    binding = rebind(timeline)
    volatile = volatile_cells(timeline)
    depleting = depleting_colors(timeline)
    votes: Counter[Rule] = Counter()
    for t in _informative(timeline):
        for rule in candidates_from(t, binding):
            votes[rule] += 1

    move_deltas: dict[int, Counter] = defaultdict(Counter)
    consumes: set[int] = set()
    pushable: set[int] = set()
    floors: Counter = Counter()
    for rule, n in votes.items():
        if isinstance(rule, MoveRule):
            for action, delta in rule.deltas:
                move_deltas[action][delta] += n
            consumes |= set(rule.consumes)
            pushable |= set(rule.pushable)
            if rule.floor is not None:
                floors[rule.floor] += n
    rules: list[Rule] = []
    if move_deltas:
        deltas = tuple(
            (action, counter.most_common(1)[0][0])
            for action, counter in sorted(move_deltas.items())
        )
        delta_map = dict(deltas)
        # Level-up transitions hide their consume event behind the board
        # swap (after = next level's grid), so mine the BEFORE grid: the
        # cell the avatar entered to complete a level must be enterable.
        for t in timeline.transitions:
            if not t.level_up or t.before is None:
                continue
            delta = delta_map.get(t.action.action)
            if delta is None or binding.avatar_color is None:
                continue
            cells = avatar_cells(t.before, binding)
            bg = binding.bg(t.before)
            for x, y in cells:
                nx, ny = x + delta[0], y + delta[1]
                if (nx, ny) not in cells and 0 <= nx < 64 and 0 <= ny < 64:
                    c = t.before[ny * 64 + nx]
                    if c not in (bg, binding.avatar_color):
                        consumes.add(c)
        # Blockers learned from CONFIRMED no-change moves (not only from
        # mispredictions: default-block semantics means a correct "blocked"
        # prediction never yields a counterexample, so specialization alone
        # would leave blockers empty and every wall an "untested assumption").
        blockers: Counter = Counter()
        # Regime guard: only count blocker evidence while the movement
        # system is demonstrably ALIVE (an energy-exhausted avatar no-ops
        # against everything, which would teach "the floor is a wall").
        informative = _informative(timeline)
        moved_recently: list[bool] = []
        window: list[bool] = []
        for t in informative:
            moved = (
                t.before is not None
                and t.after is not None
                and binding.avatar_color is not None
                and avatar_cells(t.before, binding) != avatar_cells(t.after, binding)
            )
            moved_recently.append(any(window[-4:]) or moved)
            window.append(moved)
        for idx, t in enumerate(informative):
            if (
                t.before is None
                or t.after is None
                or t.action.action not in delta_map
                or not moved_recently[idx]
            ):
                continue
            if masked(t.before, volatile, depleting) != masked(
                t.after, volatile, depleting
            ):
                continue  # something real changed: not a blocked move
            delta = delta_map[t.action.action]
            cells = avatar_cells(t.before, binding)
            bgc = binding.bg(t.before)
            for x, y in cells:
                nx, ny = x + delta[0], y + delta[1]
                if (nx, ny) not in cells and 0 <= nx < 64 and 0 <= ny < 64:
                    c = t.before[ny * 64 + nx]
                    if c in (bgc, binding.avatar_color):
                        continue
                    bx, by = nx + delta[0], ny + delta[1]
                    behind_free = (
                        0 <= bx < 64 and 0 <= by < 64
                        and t.before[by * 64 + bx] == bgc
                    )
                    if behind_free:
                        # The cell behind was free, so the color itself
                        # refused entry — true blocker evidence. A jammed
                        # push chain is NOT evidence against pushability.
                        blockers[c] += 1
        confirmed = frozenset(
            c for c, n in blockers.items()
            if n >= 2 and c not in consumes and c not in pushable
        )
        rules.append(
            MoveRule(
                deltas=deltas,
                blockers=confirmed,
                consumes=frozenset(consumes),
                pushable=frozenset(pushable),
                floor=floors.most_common(1)[0][0] if floors else None,
            )
        )
    click_votes = [
        (n, rule) for rule, n in votes.items() if isinstance(rule, ClickRule)
    ]
    if click_votes:
        # Prefer the most-supported scope; merge mappings of that scope.
        scope = max(
            ("cell", "object", "color"),
            key=lambda s: sum(n for n, r in click_votes if r.scope == s),
        )
        mapping: dict[int, int] = {}
        for n, r in sorted(click_votes, reverse=True, key=lambda p: p[0]):
            if r.scope == scope:
                for src, dst in r.mapping:
                    mapping.setdefault(src, dst)
        if mapping:
            rules.append(ClickRule(scope=scope, mapping=tuple(sorted(mapping.items()))))
    tick_by_color: dict[int, Counter] = defaultdict(Counter)
    n_change = sum(
        1
        for t in _informative(timeline)
        if t.before is not None and t.after is not None and t.before != t.after
        and not t.action.is_reset()
    )
    for rule, n in votes.items():
        if isinstance(rule, TickRule):
            if binding.avatar_color is None or rule.color != binding.avatar_color:
                tick_by_color[rule.color][rule.delta] += n
    for color, deltas in tick_by_color.items():
        delta, n = deltas.most_common(1)[0]
        # Majority delta only — a bouncing patroller votes both directions;
        # emitting both would cancel out. And a true ticker moves on most
        # transitions: occasionally-translated colors are pushed objects,
        # not passive dynamics.
        if n >= max(3, int(0.4 * n_change)):
            rules.append(TickRule(color=color, delta=delta))
    hazard_colors: Counter[int] = Counter()
    for rule, n in votes.items():
        if isinstance(rule, HazardRule):
            for c in rule.colors:
                hazard_colors[c] += n
    if hazard_colors:
        rules.append(
            HazardRule(colors=frozenset(c for c, n in hazard_colors.items() if n >= 1))
        )

    ruleset: RuleSet = tuple(rules)
    report = evaluate(ruleset, timeline, binding, volatile, depleting)
    for _ in range(max_specialize_rounds):
        if not report.counterexamples:
            break
        move = next((r for r in ruleset if isinstance(r, MoveRule)), None)
        if move is None:
            break
        improved = False
        for ce in report.counterexamples:
            for refined in specialize(move, ce, binding):
                trial = tuple(refined if r is move else r for r in ruleset)
                # Screen against the single counterexample before paying for
                # a full backtest.
                predicted, _ = step(State(ce.before), ce.action.key(), trial, binding)
                if masked(predicted.grid, volatile) != masked(ce.after, volatile):
                    continue
                trial_report = evaluate(trial, timeline, binding, volatile, depleting)
                if trial_report.contradictions < report.contradictions:
                    ruleset, report = trial, trial_report
                    improved = True
                    break
            if improved:
                break
        if not improved:
            break

    goal = infer_goal(timeline, binding)
    return Model(binding=binding, rules=ruleset, report=report, goal=goal, volatile=volatile, depleting=depleting)
