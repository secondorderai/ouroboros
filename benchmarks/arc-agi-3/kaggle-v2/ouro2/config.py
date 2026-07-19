"""Single configuration surface for the V2 harness.

One frozen dataclass, populated from at most eight OURO2_* environment
variables. There is deliberately no other configuration mechanism: every
component receives the same Config instance, so a budget or model knob can
never disagree between call sites (the V1 failure this design replaces).
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    max_actions: int = 320
    disable_model: bool = True
    model_path: str = ""
    model_backend: str = "ollama"  # "ollama" | "transformers"
    model_max_calls: int = 24
    time_budget_s: float = 600.0  # per-game CPU/wall budget for thinking
    trace_path: str = ""
    node_cap: int = 20000  # planner search-node ceiling

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        return cls(
            max_actions=int(env("OURO2_MAX_ACTIONS", "320")),
            disable_model=env("OURO2_DISABLE_MODEL", "1") not in ("", "0"),
            model_path=env("OURO2_MODEL_PATH", ""),
            model_backend=env("OURO2_MODEL_BACKEND", "ollama"),
            model_max_calls=int(env("OURO2_MODEL_MAX_CALLS", "24")),
            time_budget_s=float(env("OURO2_TIME_BUDGET_S", "600")),
            trace_path=env("OURO2_TRACE_PATH", ""),
            node_cap=int(env("OURO2_NODE_CAP", "20000")),
        )
