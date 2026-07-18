from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QWEN_CONFIG = ROOT / "config" / "qwen_candidate.json"


def model_env(name: str, default: str = "") -> str:
    """Read a model-neutral setting, falling back to its legacy Gemma name."""

    current = os.getenv(f"OURO_ARC_MODEL_{name}")
    if current is not None:
        return current
    legacy = os.getenv(f"OURO_ARC_GEMMA_{name}")
    return default if legacy is None else legacy


def model_flag(name: str, default: bool = False) -> bool:
    raw = model_env(name, "1" if default else "0")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_qwen_config(path: str | Path | None = None) -> dict[str, Any]:
    resolved = Path(
        path
        or os.getenv("OURO_ARC_MODEL_CONFIG", "")
        or DEFAULT_QWEN_CONFIG
    )
    value = json.loads(resolved.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Qwen config must be a JSON object: {resolved}")
    return value


def apply_qwen_config(
    config: dict[str, Any],
    *,
    backend: str,
    overwrite: bool = False,
) -> None:
    values = {
        "OURO_ARC_MODEL_BACKEND": backend,
        "OURO_ARC_MODEL_POLICY": config["policy"],
        "OURO_ARC_MODEL_VISION": int(bool(config["vision"])),
        "OURO_ARC_MODEL_SCIENTIST_PROMPT": int(bool(config["scientist_prompt"])),
        "OURO_ARC_MODEL_THINK": int(bool(config["think"])),
        "OURO_ARC_MODEL_INTERVAL": config["interval"],
        "OURO_ARC_MODEL_MAX_CALLS": config["max_calls"],
        "OURO_ARC_MODEL_MAX_NEW_TOKENS": config["max_new_tokens"],
        "OURO_ARC_MODEL_TIMEOUT_SECONDS": config["timeout_seconds"],
        "OURO_ARC_MODEL_TIME_BUDGET_SECONDS": config["time_budget_seconds"],
        "OURO_ARC_MODEL_DTYPE": config["dtype"],
        "OURO_ARC_MODEL_SERIALIZE_INFERENCE": int(
            bool(config["serialize_inference"])
        ),
        "OURO_ARC_INDUCTION_STUCK_ACTIONS": config["induction_stuck_actions"],
        "OURO_ARC_INDUCTION_NOVELTY_PATIENCE": config[
            "induction_novelty_patience"
        ],
        "OURO_ARC_HYPOTHESIS_MAX_CANDIDATES": config[
            "hypothesis_max_candidates"
        ],
    }
    if backend == "ollama":
        values["OURO_ARC_OLLAMA_MODEL"] = config["local_model"]
        values["OURO_ARC_MODEL_NUM_PREDICT"] = config["max_new_tokens"]
    for key, value in values.items():
        if overwrite or key not in os.environ:
            os.environ[key] = str(value)


def behavioral_contract(config: dict[str, Any]) -> dict[str, Any]:
    """Return settings that must match between Ollama and Transformers."""

    keys = (
        "model_family",
        "policy",
        "vision",
        "scientist_prompt",
        "think",
        "interval",
        "max_calls",
        "max_new_tokens",
        "timeout_seconds",
        "time_budget_seconds",
        "induction_stuck_actions",
        "induction_novelty_patience",
        "hypothesis_max_candidates",
    )
    return {key: config[key] for key in keys}
