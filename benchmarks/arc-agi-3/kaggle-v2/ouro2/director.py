"""The game director: observes, decides, and accounts for every action.

``choose(view)`` is the single entry point per turn: it first records the
previous action's observed result into the timeline (the framework gives
us the new frame as the next turn's input), then picks the next action.
It must never raise — my_agent wraps it fail-open, but the director's own
last resort is the explorer.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .config import Config
from .explore import Explorer
from .grid import Grid, grid_key, to_grid
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
        return False  # enabled in M4

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

    def _decide(self, view: FrameView) -> ActionSpec:
        if view.state == "NOT_PLAYED":
            return RESET
        if view.state == "GAME_OVER":
            return RESET
        if view.state == "WIN":
            self.wants_speedrun_flag = False
            return RESET  # only reached if is_done was overridden to continue
        if view.grid is None:
            return self._explore(view)
        return self._explore(view)

    def _explore(self, view: FrameView) -> ActionSpec:
        if view.grid is None:
            return RESET
        legal = [a for a in view.available_actions if a != 0] or [1, 2, 3, 4]
        return self.explorer.next(view.grid, list(legal))
