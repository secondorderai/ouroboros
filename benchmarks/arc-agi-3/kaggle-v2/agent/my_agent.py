"""Kaggle ARC-AGI-3 submission agent (V2).

Thin adapter over ouro2.Director; copied into the ARC-AGI-3-Agents
framework by the generated notebook. All strategy lives in ouro2 so it is
testable without the competition framework installed.
"""
from __future__ import annotations

import os
from typing import Any

from arcengine import FrameData, GameAction, GameState
from agents.agent import Agent

from ouro2.config import Config
from ouro2.director import Director, FrameView
from ouro2.timeline import ActionSpec


def _build_oracle(config: Config):
    if config.disable_model:
        return None
    from ouro2.oracle import Oracle

    return Oracle(config)


class MyAgent(Agent):
    MAX_ACTIONS = int(os.getenv("OURO2_MAX_ACTIONS", "320"))

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        config = Config.from_env()
        self.director = Director(
            config=config,
            oracle=_build_oracle(config),
            game_id=str(getattr(self, "game_id", "unknown")),
        )

    @property
    def name(self) -> str:
        return f"{super().name}.ouro2.{self.MAX_ACTIONS}"

    def is_done(self, frames: list[FrameData], latest_frame: FrameData) -> bool:
        if latest_frame.state is not GameState.WIN:
            return False
        remaining = self.MAX_ACTIONS - self.action_counter
        try:
            speedrun = self.director.on_win(
                FrameView.from_frame(latest_frame), remaining_actions=remaining
            )
        except Exception:  # noqa: BLE001
            speedrun = False
        return not (remaining > 0 and speedrun)

    def choose_action(
        self, frames: list[FrameData], latest_frame: FrameData
    ) -> GameAction:
        try:
            spec = self.director.choose(FrameView.from_frame(latest_frame))
        except Exception:  # noqa: BLE001 — a raised exception zeroes the run
            spec = ActionSpec(0, source="failsafe", reason="director error")
        return self._to_game_action(spec)

    def cleanup(self, scorecard: Any | None = None) -> None:
        super().cleanup(scorecard)
        try:
            print(f"[ouro2] {self.director.summary()}")
        except Exception:  # noqa: BLE001
            pass

    def _to_game_action(self, spec: ActionSpec) -> GameAction:
        if spec.is_reset():
            action = GameAction.RESET
        else:
            action = getattr(GameAction, f"ACTION{spec.action}")
        if spec.action == 6:
            action.set_data({"x": spec.x, "y": spec.y})
        action.reasoning = {"source": spec.source, "reason": spec.reason or spec.source}
        return action
