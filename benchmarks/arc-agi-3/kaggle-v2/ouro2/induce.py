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
# Binding (representation) induction


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
            if delta is not None and abs(delta[0]) + abs(delta[1]) == 1:
                per_color[color][t.action.action][delta] += 1
    best_color = None
    best_score = 0
    for color, by_action in per_color.items():
        majority = {a: c.most_common(1)[0] for a, c in by_action.items()}
        distinct = {delta for delta, _ in majority.values()}
        if len(majority) >= 2 and len(distinct) < 2:
            continue  # constant delta across actions: a ticker, not an avatar
        score = sum(n for _, n in majority.values())
        if score > best_score:
            best_color, best_score = color, score
    if best_color is None:
        return Binding()
    return Binding(avatar_color=best_color)


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
        out.append(MoveRule(deltas=((action, delta),)))
        # Colors that vanished where the avatar landed -> consumable.
        av_after = _cells_of(t.after, binding.avatar_color)
        eaten = {
            old
            for x, y, old, new in changed
            if new == binding.avatar_color and old not in (binding.avatar_color,)
            and old != binding.bg(t.before) and (x, y) in av_after
        }
        # A color that moved with the same delta alongside the avatar -> push.
        pushed = {
            c for c, d in moved_colors.items()
            if c != binding.avatar_color and d == delta
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


def evaluate(rules: RuleSet, timeline: Timeline, binding: Binding) -> Report:
    """Replay recorded transitions through the interpreter and compare grids
    exactly (level-up frames excluded: the env swaps the board). Bounded by
    EVALUATE_WINDOW to keep re-induction affordable."""
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
        if predicted.grid == t.after:
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
    if t.before == t.after and entered_colors:
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


def infer_goal(timeline: Timeline, binding: Binding) -> Goal | None:
    """A predicate true at every level-up and false at non-level-up states
    of the same level (negative examples are what make this sound)."""
    level_ups = [
        t
        for t in timeline.transitions
        if t.level_up and t.before is not None and t.after is not None
    ]
    if not level_ups:
        return None
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

    for goal in candidates:
        if consistent(goal):
            return goal
    return candidates[0] if candidates else None


# ---------------------------------------------------------------------------
# Orchestration


@dataclass
class Model:
    binding: Binding
    rules: RuleSet
    report: Report
    goal: Goal | None

    def healthy_for(self, level: int) -> bool:
        return bool(self.rules) and self.report.healthy_for(level)


def induce(timeline: Timeline, max_specialize_rounds: int = 4) -> Model:
    """Full (re)induction from scratch over the timeline. Time cost is
    bounded by the caller's cadence, not internally."""
    binding = rebind(timeline)
    votes: Counter[Rule] = Counter()
    for t in _informative(timeline):
        for rule in candidates_from(t, binding):
            votes[rule] += 1

    move_deltas: dict[int, Counter] = defaultdict(Counter)
    consumes: set[int] = set()
    pushable: set[int] = set()
    for rule, n in votes.items():
        if isinstance(rule, MoveRule):
            for action, delta in rule.deltas:
                move_deltas[action][delta] += n
            consumes |= set(rule.consumes)
            pushable |= set(rule.pushable)
    rules: list[Rule] = []
    if move_deltas:
        deltas = tuple(
            (action, counter.most_common(1)[0][0])
            for action, counter in sorted(move_deltas.items())
        )
        # Level-up transitions hide their consume event behind the board
        # swap (after = next level's grid), so mine the BEFORE grid: the
        # cell the avatar entered to complete a level must be enterable.
        delta_map = dict(deltas)
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
        rules.append(
            MoveRule(
                deltas=deltas,
                consumes=frozenset(consumes),
                pushable=frozenset(pushable),
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
    for rule, n in votes.items():
        if isinstance(rule, TickRule):
            if binding.avatar_color is None or rule.color != binding.avatar_color:
                tick_by_color[rule.color][rule.delta] += n
    for color, deltas in tick_by_color.items():
        delta, n = deltas.most_common(1)[0]
        # Majority delta only — a bouncing patroller votes both directions;
        # emitting both would cancel out in the interpreter.
        if n >= 3:
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
    report = evaluate(ruleset, timeline, binding)
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
                if predicted.grid != ce.after:
                    continue
                trial_report = evaluate(trial, timeline, binding)
                if trial_report.contradictions < report.contradictions:
                    ruleset, report = trial, trial_report
                    improved = True
                    break
            if improved:
                break
        if not improved:
            break

    goal = infer_goal(timeline, binding)
    return Model(binding=binding, rules=ruleset, report=report, goal=goal)
