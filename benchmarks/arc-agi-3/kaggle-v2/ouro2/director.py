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
from .grid import Grid, grid_key, to_grid
from .induce import Model, induce
from .plan import plan
from .rules import State, step
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
            key = grid_key(view.grid)
            if key in self.seen_keys:
                self.ledger.revisits += 1
            self.seen_keys.add(key)
            self.explorer.note_result(grid_key(self.last_grid), action, changed)
        # Verify the committed step (plan or speedrun): reality outranks
        # the model/recording.
        if self.pending_prediction is not None:
            if view.grid is not None and view.grid != self.pending_prediction:
                self.plan_queue.clear()
                self.speedrun_queue.clear()
                self.wants_speedrun_flag = False
                self.ledger.plan_aborts += 1
                self.reinduce_pending = True
            else:
                self.ledger.plan_steps += 1
            self.pending_prediction = None
        # Autopsy: never repeat the exact action that ended the game.
        if view.state == "GAME_OVER" and self.last_grid is not None:
            self.explorer.ban(grid_key(self.last_grid), action)
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
        if (
            model is None
            or model.goal is None
            or not model.healthy_for(view.levels_completed)
            or len(self.timeline) < self.plan_retry_at
            or self.ledger.think_time_s > self.config.time_budget_s
        ):
            return None
        state = State(view.grid, counters=self._consumed_counters(view.grid))
        legal = tuple(a for a in view.available_actions if a != 0) or (1, 2, 3, 4)
        actions = plan(
            state,
            model.rules,
            model.binding,
            model.goal,
            legal=legal,
            node_cap=self.config.node_cap,
            deadline_s=2.0,
        )
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
        action, predicted = self.plan_queue.pop(0)
        self.pending_prediction = predicted
        return action

    def _explore(self, view: FrameView) -> ActionSpec:
        if view.grid is None:
            return RESET
        legal = [a for a in view.available_actions if a != 0] or [1, 2, 3, 4]
        return self.explorer.next(view.grid, list(legal))
