"""The game director: observes, decides, and accounts for every action.

``choose(view)`` is the single entry point per turn: it first records the
previous action's observed result into the timeline (the framework gives
us the new frame as the next turn's input), then picks the next action.
It must never raise — my_agent wraps it fail-open, but the director's own
last resort is the explorer.
"""
from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass, field

from .config import Config
from .explore import Explorer
from .grid import Grid, grid_key, masked_key, to_grid
from .induce import Model, induce
from .plan import plan, plan_frontier
from .rules import MoveRule, State, step
from .timeline import RESET, ActionSpec, Timeline


@dataclass(frozen=True)
class FrameView:
    """Framework-independent view of a FrameData."""

    grid: Grid | None
    state: str  # NOT_PLAYED | NOT_FINISHED | WIN | GAME_OVER
    levels_completed: int
    win_levels: int
    available_actions: tuple[int, ...]
    full_reset: bool = False

    @classmethod
    def from_frame(cls, frame) -> "FrameView":  # FrameData duck-typed
        return cls(
            grid=to_grid(frame.frame),
            state=getattr(frame.state, "name", str(frame.state)),
            levels_completed=frame.levels_completed,
            win_levels=getattr(frame, "win_levels", 0) or 0,
            available_actions=tuple(
                getattr(a, "value", a) for a in (frame.available_actions or [])
            ),
            full_reset=bool(getattr(frame, "full_reset", False)),
        )


@dataclass
class Ledger:
    actions_used: int = 0
    noops: int = 0
    revisits: int = 0
    plan_steps: int = 0
    plan_aborts: int = 0
    probes: int = 0
    resets: int = 0
    speedrun_actions: int = 0
    think_time_s: float = 0.0


class Director:
    def __init__(self, config: Config | None = None, oracle=None, game_id: str = "") -> None:
        self.config = config or Config()
        self.oracle = oracle
        self.game_id = game_id
        self.timeline = Timeline()
        self.explorer = Explorer()
        self.ledger = Ledger()
        self.last_grid: Grid | None = None
        self.last_action: ActionSpec | None = None
        self.last_levels = 0
        self.last_state = "NOT_PLAYED"
        self.seen_keys: set[str] = set()
        self.wants_speedrun_flag = False
        # World-model path
        self.model: Model | None = None
        self.plan_queue: list[tuple[ActionSpec, Grid]] = []
        self.pending_prediction: Grid | None = None
        self.reinduce_pending = False
        self.induced_at = 0  # timeline length at last induction
        self.level_start_grid: Grid | None = None
        self.plan_retry_at = 0  # timeline length gate after a failed plan
        # Post-WIN speedrun replay (a new play can only raise the score)
        self.speedrun_queue: list[tuple[ActionSpec, Grid | None]] = []
        self.speedrun_done = False
        self.last_novel_at = 0  # timeline length when a new state last appeared
        self.last_stuck_reset_at = 0
        self.aborts_since_induce = 0
        self.model_paused_until = 0  # circuit breaker: timeline length gate
        self.breaker_trips: dict[int, int] = {}
        self.model_disabled_levels: set[int] = set()
        self.frontier_disabled_levels: set[int] = set()
        self.plan_queue_source = ""
        # Observed transition graph over masked keys (model-free navigation)
        self.graph_edges: dict[tuple[str, tuple], Counter] = {}
        self.lethal_edges: set[tuple[str, tuple]] = set()
        # Cumulative identity masks: monotone unions, so mask jitter between
        # inductions cannot thrash the key epoch (every rebuild wipes
        # exploration memory — rebuilds must be rare and meaningful).
        self.mask_volatile: frozenset[int] = frozenset()
        self.mask_depleting: frozenset[int] = frozenset()
        self.mask_avatar: int | None = None

    def _key(self, g: Grid) -> str:
        from .induce import masked

        return masked_key(
            masked(g, self.mask_volatile, self.mask_depleting, keep=self.mask_avatar),
            frozenset(),
        )

    # -- framework hooks -------------------------------------------------
    def wants_speedrun(self) -> bool:
        return self.wants_speedrun_flag

    def on_win(self, view: FrameView, remaining_actions: int = 0) -> bool:
        """Called from is_done when the WIN frame arrives (before any further
        choose). Records the final transition and decides whether to spend
        remaining budget on a speedrun replay. Idempotent: _record consumes
        the pending action."""
        try:
            self._record(view)
            self.last_grid = view.grid or self.last_grid
            self.last_levels = view.levels_completed
            self.last_state = view.state
            self.wants_speedrun_flag = self._decide_speedrun(remaining_actions)
        except Exception:  # noqa: BLE001
            self.wants_speedrun_flag = False
        return self.wants_speedrun_flag

    def _decide_speedrun(self, remaining_actions: int) -> bool:
        """After WIN: re-earn the game in a fresh play with a COMPRESSED
        path — per level, a BFS plan inside the induced model if shorter,
        else the recorded actions. Score = max over plays, so this can only
        raise the score; per-step verification aborts back to live play on
        any divergence. Skipped when nothing compresses (a verbatim replay
        can only tie)."""
        if self.speedrun_done:
            return False
        win_play = next(
            (
                p
                for p in self.timeline.plays()
                if any(t.state_after == "WIN" for t in p)
            ),
            None,
        )
        if win_play is None:
            return False
        queue: list[tuple[ActionSpec, Grid | None]] = []
        recorded_total = 0
        compressed = False
        segments: dict[int, list] = {}
        for t in win_play:
            if not t.full_reset:
                segments.setdefault(t.level, []).append(t)
        model = self.model
        for level in sorted(segments):
            ts = segments[level]
            recorded_total += len(ts)
            start = ts[0].before
            planned = None
            if model is not None and model.goal is not None and start is not None:
                planned = plan(
                    State(start),
                    model.rules,
                    model.binding,
                    model.goal,
                    node_cap=self.config.node_cap,
                    deadline_s=2.0,
                )
            if planned and len(planned) < len(ts):
                compressed = True
                sim = State(start)
                for i, spec in enumerate(planned):
                    sim, _ = step(sim, spec.key(), model.rules, model.binding)
                    expected = None if i == len(planned) - 1 else sim.grid
                    queue.append(
                        (
                            ActionSpec(
                                spec.action, spec.x, spec.y,
                                source="speedrun", reason="planned replay",
                            ),
                            expected,  # level-up swaps the board: unverifiable
                        )
                    )
            else:
                for t in ts:
                    a = t.action
                    queue.append(
                        (
                            ActionSpec(a.action, a.x, a.y, source="speedrun",
                                       reason="recorded replay"),
                            t.after,
                        )
                    )
        needed = len(queue) + 1  # +1 for the RESET opening the new play
        if not queue or not compressed or remaining_actions < needed * 1.15:
            return False
        self.speedrun_queue = queue
        self.speedrun_done = True
        return True

    def choose(self, view: FrameView) -> ActionSpec:
        started = time.monotonic()
        try:
            self._record(view)
            action = self._decide(view)
        except Exception:  # noqa: BLE001 — never abort the run
            action = self._explore(view)
        self.last_action = action
        if view.grid is not None:
            self.last_grid = view.grid
        self.last_levels = view.levels_completed
        self.last_state = view.state
        self.ledger.actions_used += 1
        if action.is_reset():
            self.ledger.resets += 1
        self.ledger.think_time_s += time.monotonic() - started
        return action

    def summary(self) -> dict:
        return {
            "game_id": self.game_id,
            "actions": self.ledger.actions_used,
            "noops": self.ledger.noops,
            "revisits": self.ledger.revisits,
            "plan_steps": self.ledger.plan_steps,
            "plan_aborts": self.ledger.plan_aborts,
            "probes": self.ledger.probes,
            "resets": self.ledger.resets,
            "speedrun_actions": self.ledger.speedrun_actions,
            "think_time_s": round(self.ledger.think_time_s, 3),
            "transitions": len(self.timeline),
            "levels_completed": self.last_levels,
        }

    # -- internals -------------------------------------------------------
    def _record(self, view: FrameView) -> None:
        if self.last_action is None:
            return
        action, self.last_action = self.last_action, None  # consume: idempotent
        self.timeline.append(
            before=self.last_grid,
            action=action,
            after=view.grid,
            state_after=view.state,
            levels_before=self.last_levels,
            levels_after=view.levels_completed,
            full_reset=view.full_reset,
        )
        if view.grid is not None and self.last_grid is not None:
            changed = view.grid != self.last_grid
            if not changed and not action.is_reset():
                self.ledger.noops += 1
            key = self._key(view.grid)
            if key in self.seen_keys:
                self.ledger.revisits += 1
            else:
                self.last_novel_at = len(self.timeline)
            self.seen_keys.add(key)
            self.explorer.note_result(
                self._key(self.last_grid), action, changed, grid=self.last_grid
            )
            if not action.is_reset():
                edge = (self._key(self.last_grid), action.key())
                self.graph_edges.setdefault(edge, Counter())[key] += 1
        # Verify the committed step (plan or speedrun): reality outranks
        # the model/recording.
        if self.pending_prediction is not None:
            mismatch = view.grid is not None and view.grid != self.pending_prediction
            if mismatch and self.model is not None:
                # Strict masked equality: the depleting/volatile masks absorb
                # legitimate HUD churn; any remaining difference is a real
                # misprediction (a lenient executor never aborts, which
                # defeats the one-strike frontier policy).
                mismatch = self.model.masked(view.grid) != self.model.masked(
                    self.pending_prediction
                )
            if mismatch:
                self.plan_queue.clear()
                self.speedrun_queue.clear()
                self.wants_speedrun_flag = False
                self.ledger.plan_aborts += 1
                self.reinduce_pending = True
                self.aborts_since_induce += 1
                if self.plan_queue_source == "plan-frontier":
                    # One strike per level: a model whose curiosity plans
                    # mispredict loses frontier control until the next level
                    # (goal plans keep their own breaker). The floor owns
                    # unreliable-model games.
                    self.frontier_disabled_levels.add(view.levels_completed)
                if self.aborts_since_induce >= 6:
                    # Circuit breaker: a chronically mispredicting model must
                    # not keep steering (strict additivity) — floor only for
                    # a long window; two trips on one level disable the model
                    # path for that level entirely.
                    self.model_paused_until = len(self.timeline) + 64
                    self.aborts_since_induce = 0
                    level = view.levels_completed
                    self.breaker_trips[level] = self.breaker_trips.get(level, 0) + 1
            else:
                self.ledger.plan_steps += 1
            self.pending_prediction = None
        # Autopsy: never repeat the exact action that ended the game.
        if view.state == "GAME_OVER" and self.last_grid is not None:
            self.explorer.ban(self._key(self.last_grid), action)
            self.lethal_edges.add((self._key(self.last_grid), action.key()))
        # Track the level-start grid for consumed-counter reconstruction.
        if view.levels_completed != self.last_levels or view.full_reset or (
            action.is_reset() and view.grid is not None
        ):
            self.level_start_grid = view.grid
            self.plan_queue.clear()
            self.pending_prediction = None

    def _decide(self, view: FrameView) -> ActionSpec:
        if view.state == "NOT_PLAYED":
            return RESET
        if view.state == "GAME_OVER":
            self.plan_queue.clear()
            self.speedrun_queue.clear()
            self.wants_speedrun_flag = False
            self.pending_prediction = None
            self.reinduce_pending = True
            return RESET
        if view.state == "WIN":
            if self.wants_speedrun_flag and self.speedrun_queue:
                return RESET  # full reset at WIN: starts the replay play
            self.wants_speedrun_flag = False
            return RESET
        if view.grid is None:
            return self._explore(view)
        # Stuck escape: no novel state for a long stretch usually means an
        # irreversible dead position (cornered sokoban box) — a level reset
        # is the only exit, and it costs one action.
        if (
            len(self.timeline) - self.last_novel_at >= 96
            and len(self.timeline) - self.last_stuck_reset_at >= 96
            and self.timeline.current_level_transitions()
        ):
            self.last_stuck_reset_at = len(self.timeline)
            self.reinduce_pending = True
            return ActionSpec(0, source="director", reason="stuck: level reset")
        if self.speedrun_queue:
            action, expected = self.speedrun_queue.pop(0)
            self.pending_prediction = expected
            self.ledger.speedrun_actions += 1
            return action
        if self.plan_queue:
            action, predicted = self.plan_queue.pop(0)
            self.pending_prediction = predicted
            return action
        self._maybe_reinduce()
        planned = self._try_plan(view)
        if planned is not None:
            return planned
        return self._explore(view)

    def _maybe_reinduce(self) -> None:
        if self.ledger.think_time_s > self.config.time_budget_s:
            return  # over budget: degrade to the explorer floor
        grown = len(self.timeline) - self.induced_at
        if self.model is None or self.reinduce_pending or grown >= 16:
            if len(self.timeline) >= 4:
                self.model = induce(self.timeline)
                self.induced_at = len(self.timeline)
                self.reinduce_pending = False
                self.plan_retry_at = 0  # new evidence: planning may retry
                new_vol = self.mask_volatile | self.model.volatile
                new_dep = self.mask_depleting | self.model.depleting
                new_avatar = self.model.binding.avatar_color or self.mask_avatar
                if (
                    new_vol != self.mask_volatile
                    or new_dep != self.mask_depleting
                    or new_avatar != self.mask_avatar
                ):
                    self.mask_volatile = new_vol
                    self.mask_depleting = new_dep
                    self.mask_avatar = new_avatar
                    self._rebuild_keys()
                self._oracle_goal_tiebreak()

    def _rebuild_keys(self) -> None:
        """The state-identity function just changed (new volatility mask or
        avatar binding): every derived key set would fragment across epochs.
        The timeline is ground truth — rebuild them all under the new mask."""
        self.seen_keys.clear()
        self.graph_edges.clear()
        self.lethal_edges.clear()
        ex = self.explorer
        ex.tried.clear()
        ex.noop_bans.clear()
        ex.last_used.clear()
        for t in self.timeline.transitions:
            if t.after is not None:
                self.seen_keys.add(self._key(t.after))
            if t.before is None:
                continue
            key = self._key(t.before)
            ex.clock += 1
            if not t.action.is_reset():
                ex.last_used[(key, t.action.key())] = ex.clock
            changed = t.after is not None and t.after != t.before
            ex.note_result(key, t.action, changed, grid=t.before)
            if t.after is not None and not t.action.is_reset():
                self.graph_edges.setdefault(
                    (key, t.action.key()), Counter()
                )[self._key(t.after)] += 1
            if t.state_after == "GAME_OVER":
                ex.ban(key, t.action)
                self.lethal_edges.add((key, t.action.key()))

    def _oracle_goal_tiebreak(self) -> None:
        """When several goal predicates survive the negative examples, let
        the oracle pick; its answer is one of OUR candidates or ignored."""
        if self.oracle is None or self.model is None:
            return
        from .induce import infer_goal_candidates
        from .rules import Goal

        goals = infer_goal_candidates(self.timeline, self.model.binding)
        if len(goals) <= 1:
            return
        render = {f"{g.kind} color={g.color} n={g.count}": g for g in goals}
        choices = list(render)
        picked = self.oracle.select(
            "GOAL_SELECT",
            "Which condition most plausibly completes a level of this game?",
            choices,
            default=choices[0],
        )
        self.model.goal = render.get(picked, goals[0])

    def _frontier_eligible(self, model: Model, view: FrameView) -> bool:
        """Frontier probing needs only a usable move-model: misses may run
        higher than the exploit gate (probes are cheap and per-step
        verified — an abort just returns to the explorer)."""
        # Schema's bar: frontier probing (which steers real actions on pure
        # curiosity) only from a model with a CLEAN backtest for this level.
        # Goal-directed exploit planning keeps its small tolerance elsewhere.
        from .rules import TickRule

        return (
            any(isinstance(r, MoveRule) for r in model.rules)
            # v2.0 restriction: no frontier probing in ticker games — a
            # patroller's phase leaks into model-novelty in ways the masks
            # cannot fully hide, and the floor handles these games better.
            and not any(isinstance(r, TickRule) for r in model.rules)
            and model.binding.avatar_color is not None
            and model.report.misses_by_level.get(view.levels_completed, 0) == 0
            and model.report.support >= 12
        )

    def _consumed_counters(self, current: Grid) -> tuple[tuple[int, int], ...]:
        if self.level_start_grid is None:
            return ()
        start = Counter(self.level_start_grid)
        now = Counter(current)
        consumed = {
            c: start[c] - now.get(c, 0)
            for c in start
            if start[c] - now.get(c, 0) > 0
        }
        return tuple(sorted(consumed.items()))

    def _try_plan(self, view: FrameView) -> ActionSpec | None:
        model = self.model
        attempted = self.ledger.plan_steps + self.ledger.plan_aborts
        failing = attempted >= 6 and self.ledger.plan_aborts / attempted > 0.5
        if (
            model is None
            or len(self.timeline) < self.plan_retry_at
            or len(self.timeline) < self.model_paused_until
            or failing
            or self.ledger.think_time_s > self.config.time_budget_s
        ):
            return None
        state = State(view.grid, counters=self._consumed_counters(view.grid))
        legal = tuple(a for a in view.available_actions if a != 0) or (1, 2, 3, 4)
        actions = None
        if model.goal is not None and model.healthy_for(view.levels_completed):
            actions = plan(
                state,
                model.rules,
                model.binding,
                model.goal,
                legal=legal,
                node_cap=self.config.node_cap,
                deadline_s=2.0,
            )
        if (
            not actions
            and view.levels_completed not in self.frontier_disabled_levels
            and self._frontier_eligible(model, view)
        ):
            # No goal yet (level 0 is the lab) or goal unreachable: use the
            # verified move-model for shortest-path novelty probing instead
            # of rotor-router wandering.
            actions = plan_frontier(
                state,
                model.rules,
                model.binding,
                self.seen_keys,
                legal=legal,
                node_cap=self.config.node_cap,
                deadline_s=1.0,
                volatile=self.mask_volatile,
                depleting=self.mask_depleting,
                banned=self.explorer.noop_bans,
            )
            if actions:
                self.ledger.probes += len(actions)
        if not actions:
            # Cool down: don't re-pay BFS cost until new evidence arrives.
            self.plan_retry_at = len(self.timeline) + 8
            return None
        # Precompute per-step predicted grids for the executor.
        queue: list[tuple[ActionSpec, Grid]] = []
        sim = state
        for spec in actions:
            sim, _ = step(sim, spec.key(), model.rules, model.binding)
            queue.append((spec, sim.grid))
        self.plan_queue = queue
        self.plan_queue_source = actions[0].source if actions else ""
        action, predicted = self.plan_queue.pop(0)
        self.pending_prediction = predicted
        return action

    def _explore(self, view: FrameView) -> ActionSpec:
        if view.grid is None:
            return RESET
        legal = [a for a in view.available_actions if a != 0] or [1, 2, 3, 4]
        action = self.explorer.next(view.grid, list(legal))
        if action.reason == "lru sweep":
            # Nothing untried here: walk the OBSERVED graph to the nearest
            # state that still has untried actions (model-free, so it works
            # even when the induced model is unclean). Self-correcting: each
            # step re-runs this.
            routed = self._graph_frontier_step(view, legal)
            if routed is not None:
                return routed
        return action

    def _graph_frontier_step(self, view: FrameView, legal: list[int]) -> ActionSpec | None:
        from collections import deque

        start = self._key(view.grid)
        adjacency: dict[str, list] = {}
        for (from_key, action_key), targets in self.graph_edges.items():
            if (from_key, action_key) in self.lethal_edges:
                continue  # an edge that EVER killed is off-limits to routing
            adjacency.setdefault(from_key, []).append(
                (action_key, targets.most_common(1)[0][0])
            )
        seen = {start}
        queue = deque([(start, None)])  # (key, first action on path)
        expanded = 0
        while queue:
            expanded += 1
            if expanded > 600:
                return None
            key, first = queue.popleft()
            if key != start:
                tried = self.explorer.tried.get(key, set())
                for a in legal:
                    if a == 6:
                        continue  # graph nav targets simple-action frontiers
                    k = (a, None, None)
                    if k not in tried and (key, k) not in self.explorer.noop_bans:
                        if first is None:
                            return None
                        return ActionSpec(
                            first[0], first[1], first[2],
                            source="graph-frontier", reason="route to untried",
                        )
            for action_key, nxt in adjacency.get(key, ()):
                if nxt in seen:
                    continue
                seen.add(nxt)
                queue.append((nxt, first if first is not None else action_key))
        return None
