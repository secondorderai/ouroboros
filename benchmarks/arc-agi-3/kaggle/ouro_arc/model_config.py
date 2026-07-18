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
    optional_values = {
        "OURO_ARC_MODEL_DO_SAMPLE": int(bool(config.get("do_sample"))) if "do_sample" in config else None,
        "OURO_ARC_MODEL_TEMPERATURE": config.get("temperature"),
        "OURO_ARC_MODEL_TOP_P": config.get("top_p"),
        "OURO_ARC_MODEL_TOP_K": config.get("top_k"),
        "OURO_ARC_MODEL_SEED": config.get("seed"),
        "OURO_ARC_MODEL_FP8_FIX_GATE_PROJ": int(bool(config.get("fp8_fix_gate_proj"))) if "fp8_fix_gate_proj" in config else None,
        "OURO_ARC_MODEL_REQUIRE_SCALED_FP8": int(bool(config.get("require_scaled_fp8"))) if "require_scaled_fp8" in config else None,
        "OURO_ARC_WORLD_MODEL_MODE": config.get("world_model_mode"),
        "OURO_ARC_WORLD_MODEL_BEAM": config.get("world_model_beam"),
        "OURO_ARC_WORLD_MODEL_WORKER_TIMEOUT_SECONDS": config.get("worker_timeout_seconds"),
        "OURO_ARC_WORLD_MODEL_MEMORY_MB": config.get("worker_memory_mb"),
        "OURO_ARC_WORLD_MODEL_SEARCH_STATES": config.get("search_states"),
        "OURO_ARC_WORLD_MODEL_SEARCH_DEPTH": config.get("search_depth"),
        "OURO_ARC_MODEL_CRITIC": int(bool(config.get("critic"))) if "critic" in config else None,
        "OURO_ARC_SHARED_MECHANICS": int(bool(config.get("shared_mechanics"))) if "shared_mechanics" in config else None,
        "OURO_ARC_DISCOVERY_ACTIONS": config.get("discovery_actions"),
        "OURO_ARC_WORLD_MODEL_MAX_STALLED_REVISIONS": config.get("max_stalled_revisions"),
        "OURO_ARC_WORLD_MODEL_PROMPT_MAX_CHARS": config.get("prompt_max_chars"),
        "OURO_ARC_DISCOVERY_BARRIER_SECONDS": config.get("discovery_barrier_seconds"),
        "OURO_ARC_DISCOVERY_BARRIER_ENABLED": int(bool(config.get("discovery_barrier"))) if "discovery_barrier" in config else None,
    }
    values.update({key: value for key, value in optional_values.items() if value is not None})
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
    optional = (
        "world_model_mode",
        "world_model_beam",
        "worker_timeout_seconds",
        "worker_memory_mb",
        "search_states",
        "search_depth",
        "critic",
        "shared_mechanics",
        "discovery_actions",
        "max_stalled_revisions",
        "prompt_max_chars",
        "discovery_barrier_seconds",
        "discovery_barrier",
        "do_sample",
        "temperature",
        "top_p",
        "top_k",
        "seed",
        "thinking_generation",
        "nonthinking_generation",
        "fp8_fix_gate_proj",
        "require_scaled_fp8",
    )
    return {
        key: config[key]
        for key in (*keys, *optional)
        if key in config
    }
