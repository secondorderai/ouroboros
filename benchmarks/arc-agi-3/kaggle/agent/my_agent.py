"""Kaggle ARC-AGI-3 submission agent.

This file is copied into the ARC-AGI-3-Agents framework by the generated
notebook. It stays intentionally thin: all strategy logic lives in `ouro_arc`
so it can be unit-tested without the competition framework installed.
"""
from __future__ import annotations

import os
from typing import Any

from arcengine import FrameData, GameAction, GameState
from agents.agent import Agent

from ouro_arc import ActionSpec, ArcController
from ouro_arc.gemma import GemmaAdvisor


class MyAgent(Agent):
    MAX_ACTIONS = int(os.getenv("OURO_ARC_MAX_ACTIONS", "320"))

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        require_model = bool(os.getenv("KAGGLE_IS_COMPETITION_RERUN")) and not bool(
            os.getenv("OURO_ARC_DISABLE_MODEL")
        )
        self.controller = ArcController(
            advisor=GemmaAdvisor(require_model=require_model),
        )
        if require_model:
            self.controller.advisor.ensure_available()

    @property
    def name(self) -> str:
        return f"{super().name}.ouro-gemma4-12b.{self.MAX_ACTIONS}"

    def is_done(self, frames: list[FrameData], latest_frame: FrameData) -> bool:
        return latest_frame.state is GameState.WIN

    def choose_action(
        self,
        frames: list[FrameData],
        latest_frame: FrameData,
    ) -> GameAction:
        action = self.controller.choose(latest_frame)
        return self._to_game_action(action)

    def _to_game_action(self, spec: ActionSpec) -> GameAction:
        if spec.is_reset():
            action = GameAction.RESET
        else:
            action = getattr(GameAction, f"ACTION{spec.action}")
        if spec.action == 6:
            action.set_data({"x": spec.x, "y": spec.y})
        reason = spec.reason or spec.source
        action.reasoning = {"source": spec.source, "reason": reason}
        return action
