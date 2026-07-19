"""FakeEnv: mirrors arcengine semantics for headless end-to-end tests.

Each synthetic game implements its OWN bespoke logic (never ouro2.rules),
so induction is tested against an independent implementation. Engine
semantics mirrored from arcengine/base_game.py:
- non-RESET during WIN/GAME_OVER burns the action and returns an EMPTY
  frame stack;
- RESET at level start (action_count==0) or at WIN -> full reset (new
  play, level 0, full_reset=True); otherwise level reset (same play);
- completing the last level -> WIN.
"""
from __future__ import annotations

from ouro2.director import FrameView
from ouro2.grid import SIZE
from ouro2.timeline import ActionSpec

BG = 0


class SyntheticGame:
    """Interface synthetic games implement."""

    n_levels: int = 1
    available: tuple[int, ...] = (0, 1, 2, 3, 4)

    def initial(self, level: int) -> dict:
        raise NotImplementedError

    def render(self, state: dict) -> list[list[int]]:
        raise NotImplementedError

    def apply(self, state: dict, action: ActionSpec) -> tuple[dict, bool, bool]:
        """Returns (new_state, level_completed, game_over)."""
        raise NotImplementedError


class FakeEnv:
    def __init__(self, game: SyntheticGame):
        self.game = game
        self.state = "NOT_PLAYED"
        self.levels_completed = 0
        self.level = 0
        self.level_state: dict | None = None
        self.action_count = 0  # per-level, non-RESET actions
        self.actions_issued = 0
        self.plays = 0

    def initial_view(self) -> FrameView:
        return self._view(grid_rows=None, full_reset=False)

    def step(self, action: ActionSpec) -> FrameView:
        self.actions_issued += 1
        if action.is_reset():
            if self.state == "WIN" or self.action_count == 0 or self.state == "NOT_PLAYED":
                self.plays += 1
                self.level = 0
                self.levels_completed = 0
                self.level_state = self.game.initial(0)
                self.action_count = 0
                self.state = "NOT_FINISHED"
                return self._view(self.game.render(self.level_state), full_reset=True)
            # level reset, same play
            self.level_state = self.game.initial(self.level)
            self.action_count = 0
            self.state = "NOT_FINISHED"
            return self._view(self.game.render(self.level_state), full_reset=False)
        if self.state in ("WIN", "GAME_OVER", "NOT_PLAYED"):
            return self._view(grid_rows=[], full_reset=False)  # burned
        self.action_count += 1
        assert self.level_state is not None
        self.level_state, completed, game_over = self.game.apply(self.level_state, action)
        if game_over:
            self.state = "GAME_OVER"
            return self._view(self.game.render(self.level_state), full_reset=False)
        if completed:
            self.levels_completed += 1
            if self.levels_completed >= self.game.n_levels:
                self.state = "WIN"
                return self._view(self.game.render(self.level_state), full_reset=False)
            self.level += 1
            self.level_state = self.game.initial(self.level)
            self.action_count = 0
        return self._view(self.game.render(self.level_state), full_reset=False)

    def _view(self, grid_rows, full_reset: bool) -> FrameView:
        from ouro2.grid import to_grid

        grid = to_grid([grid_rows]) if grid_rows else None
        return FrameView(
            grid=grid,
            state=self.state,
            levels_completed=self.levels_completed,
            win_levels=self.game.n_levels,
            available_actions=self.game.available,
            full_reset=full_reset,
        )


def run_agent(env: FakeEnv, director, max_actions: int = 320) -> FrameView:
    """The framework main loop, headless (mirrors agents/agent.py:
    is_done(latest) is evaluated BEFORE choose_action each turn)."""
    view = env.initial_view()
    actions = 0
    while actions <= max_actions:
        if view.state == "WIN":
            if not director.on_win(view, remaining_actions=max_actions - actions):
                break
        action = director.choose(view)
        view = env.step(action)
        actions += 1
    return view


def empty_rows() -> list[list[int]]:
    return [[BG] * SIZE for _ in range(SIZE)]
