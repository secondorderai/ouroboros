from __future__ import annotations

import json
import os
from pathlib import Path
from textwrap import dedent


ACCELERATOR = "rtx6000"
_ACCELERATORS = {
    "cpu": {"name": "none", "gpu": False},
    "t4": {"name": "nvidiaTeslaT4", "gpu": True},
    "p100": {"name": "nvidiaTeslaP100", "gpu": True},
    "rtx6000": {"name": "nvidiaRtx6000", "gpu": True},
}

QWEN_MODEL_SOURCE = "kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"
QWEN_RUNTIME_DATASET_SOURCE = "kinwochan/ouroboros-qwen-runtime-wheels"

# The default submission is deterministic-only: earlier model-active reruns scored 0.00
# (submission versions 7 and 8) when advisor failures were fatal. Advisor
# failures now degrade to deterministic play, but Qwen stays opt-in per build.
DETERMINISTIC_ENV_BLOCK = dedent(
    """\
    # Deterministic submission: model inference is disabled on every path.
    # Build with OURO_ARC_SUBMISSION_QWEN=1 for the validated Qwen variant.
    os.environ["OURO_ARC_DISABLE_MODEL"] = "1"
    os.environ["OURO_ARC_MODEL_POLICY"] = "off"
    os.environ["OURO_ARC_MODEL_MAX_CALLS"] = "0"
    os.environ["OURO_ARC_MODEL_VISION"] = "0"
    """
).rstrip("\n")

def submission_qwen_enabled() -> bool:
    return os.getenv("OURO_ARC_SUBMISSION_QWEN", "").lower() in {"1", "true", "yes"}

ROOT = Path(__file__).resolve().parents[1]
AGENT_SRC = ROOT / "agent" / "my_agent.py"
PACKAGE_DIR = ROOT / "ouro_arc"
NOTEBOOK_PATH = ROOT / "notebooks" / "submission.ipynb"
METADATA_PATH = ROOT / "notebooks" / "kernel-metadata.json"
DEFAULT_PROMOTION_CONFIG = ROOT / "config" / "qwen_promoted.json"


def load_promoted_config() -> dict:
    path = Path(os.getenv("OURO_ARC_QWEN_PROMOTION_CONFIG", str(DEFAULT_PROMOTION_CONFIG)))
    if not path.exists():
        raise SystemExit(
            "Qwen submission requires a passing RTX 6000 validation promotion config. "
            f"Missing: {path}. Run make kaggle-gpu-promote after pulling results."
        )
    config = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "backend",
        "policy",
        "vision",
        "scientist_prompt",
        "think",
        "interval",
        "max_calls",
        "max_new_tokens",
        "timeout_seconds",
        "time_budget_seconds",
        "dtype",
        "serialize_inference",
    }
    missing = sorted(required - set(config))
    if missing:
        raise SystemExit(f"Invalid Qwen promotion config; missing keys: {missing}")
    return config


def qwen_env_block(config: dict) -> str:
    values = {
        "OURO_ARC_MODEL_BACKEND": config["backend"],
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
        "OURO_ARC_MODEL_SERIALIZE_INFERENCE": int(bool(config["serialize_inference"])),
        "OURO_ARC_MODEL_REQUIRE_CUDA": 1,
    }
    lines = [
        "# Promoted Qwen configuration from a passing RTX 6000 public-game run.",
        "# Model failures remain non-fatal and fall back to deterministic play.",
    ]
    lines.extend(
        f'os.environ[{key!r}] = {str(value)!r}'
        for key, value in values.items()
    )
    return "\n".join(lines)


def code_cell(source: str) -> dict:
    return {
        "cell_type": "code",
        "metadata": {"trusted": True},
        "outputs": [],
        "execution_count": None,
        "source": source,
    }


def markdown_cell(source: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": source}


def _writefile_cell(path: str, body: str) -> dict:
    return code_cell(f"%%writefile {path}\n{body}")


def _package_cells() -> list[dict]:
    cells = [code_cell("!mkdir -p /tmp/ouro_arc")]
    for path in sorted(PACKAGE_DIR.glob("*.py")):
        cells.append(_writefile_cell(f"/tmp/ouro_arc/{path.name}", path.read_text()))
    for path in sorted(PACKAGE_DIR.glob("*.json")):
        cells.append(_writefile_cell(f"/tmp/ouro_arc/{path.name}", path.read_text()))
    cells.append(_writefile_cell("/tmp/my_agent.py", AGENT_SRC.read_text()))
    return cells


def build() -> dict:
    if ACCELERATOR not in _ACCELERATORS:
        raise SystemExit(f"Unknown ACCELERATOR={ACCELERATOR!r}")
    accel = _ACCELERATORS[ACCELERATOR]
    env_block = (
        qwen_env_block(load_promoted_config())
        if submission_qwen_enabled()
        else DETERMINISTIC_ENV_BLOCK
    )

    install_sources = (
        "    --find-links /kaggle/input/ouroboros-qwen-runtime-wheels \\\n"
        if submission_qwen_enabled()
        else ""
    )
    model_packages = ' "transformers==5.12.0" "accelerate==1.10.1"' if submission_qwen_enabled() else ""
    install_cell = code_cell(
        "!pip install --no-index \\\n"
        "    --find-links /kaggle/input/competitions/arc-prize-2026-arc-agi-3/arc_agi_3_wheels \\\n"
        + install_sources
        + "    arc-agi python-dotenv pandas pyarrow"
        + model_packages
    )

    input_discovery_cell = code_cell(
        dedent(
            """\
            import os

            print("KAGGLE_IS_COMPETITION_RERUN=", os.getenv("KAGGLE_IS_COMPETITION_RERUN"))
            print("OURO_ARC_MODEL_PATH=", os.getenv("OURO_ARC_MODEL_PATH"))
            print("Discovering Qwen3.5-4B paths under /kaggle/input:")
            found_qwen_paths = []
            if os.path.exists("/kaggle/input"):
                for root, dirs, files in os.walk("/kaggle/input"):
                    if "qwen-3-5-4b" in root.lower() and "config.json" in files:
                        found_qwen_paths.append(root)
                        print(root)
                print(f"Found {len(found_qwen_paths)} Qwen model directories")
                if found_qwen_paths and not os.getenv("OURO_ARC_MODEL_PATH"):
                    os.environ["OURO_ARC_MODEL_PATH"] = sorted(found_qwen_paths)[0]
            else:
                print("/kaggle/input does not exist in this environment")
            """
        )
    )

    run_cell = code_cell(
        dedent(
            """\
            import os
            import json
            import time
            import urllib.error
            import urllib.request

            def write_run_summary(**values):
                path = "/kaggle/working/ouro_arc_summary.json"
                current = {}
                try:
                    if os.path.exists(path):
                        with open(path, "r", encoding="utf-8") as f:
                            current = json.load(f)
                except Exception:
                    current = {}
                current.update(values)
                try:
                    with open(path, "w", encoding="utf-8") as f:
                        json.dump(current, f, indent=2, sort_keys=True)
                        f.write("\\n")
                except OSError:
                    pass

            def gateway_available(retries=3, delay=1.0, timeout=2.0):
                url = "http://gateway:8001/api/games"
                for attempt in range(1, retries + 1):
                    try:
                        with urllib.request.urlopen(url, timeout=timeout) as response:
                            if 200 <= response.status < 500:
                                return True
                    except (OSError, urllib.error.URLError):
                        pass
                    if attempt < retries:
                        time.sleep(delay)
                return False

            competition_rerun_detected = bool(os.getenv("KAGGLE_IS_COMPETITION_RERUN"))
            gateway_up = gateway_available(
                retries=120 if competition_rerun_detected else 3,
                delay=5.0 if competition_rerun_detected else 1.0,
                timeout=2.0,
            )
            run_arc_agent = competition_rerun_detected or gateway_up
            selected_execution_path = "arc-agent" if run_arc_agent else "dummy-submission"
            __OURO_MODEL_ENV_BLOCK__
            os.environ.setdefault("OURO_ARC_MODEL_INTERVAL", "16")
            os.environ.setdefault("OURO_ARC_MAX_ACTIONS", "320")
            print("competition_rerun_detected=", competition_rerun_detected)
            print("gateway_available=", gateway_up)
            print("selected_execution_path=", selected_execution_path)
            write_run_summary(
                competition_rerun_detected=competition_rerun_detected,
                gateway_available=gateway_up,
                selected_execution_path=selected_execution_path,
                disable_model=os.getenv("OURO_ARC_DISABLE_MODEL"),
                model_policy=os.getenv("OURO_ARC_MODEL_POLICY"),
                model_max_calls=os.getenv("OURO_ARC_MODEL_MAX_CALLS"),
                model_interval=os.getenv("OURO_ARC_MODEL_INTERVAL"),
                model_vision=os.getenv("OURO_ARC_MODEL_VISION"),
                model_backend=os.getenv("OURO_ARC_MODEL_BACKEND"),
                model_think=os.getenv("OURO_ARC_MODEL_THINK"),
                model_scientist_prompt=os.getenv("OURO_ARC_MODEL_SCIENTIST_PROMPT"),
                model_max_new_tokens=os.getenv("OURO_ARC_MODEL_MAX_NEW_TOKENS"),
                model_dtype=os.getenv("OURO_ARC_MODEL_DTYPE"),
            )

            if run_arc_agent:
                if not gateway_up:
                    print("Warning: rerun flag set but gateway probe failed; starting agent anyway")

                !cp -r /kaggle/input/competitions/arc-prize-2026-arc-agi-3/ARC-AGI-3-Agents \\
                       /kaggle/working/ARC-AGI-3-Agents
                !cp /tmp/my_agent.py \\
                    /kaggle/working/ARC-AGI-3-Agents/agents/templates/my_agent.py
                !cp -r /tmp/ouro_arc /kaggle/working/ARC-AGI-3-Agents/ouro_arc

                with open('/kaggle/working/ARC-AGI-3-Agents/agents/__init__.py', 'w') as f:
                    f.write(\"\"\"from typing import Type
            from dotenv import load_dotenv
            from .agent import Agent, Playback
            from .swarm import Swarm
            from .templates.random_agent import Random
            from .templates.my_agent import MyAgent

            load_dotenv()

            AVAILABLE_AGENTS: dict[str, Type[Agent]] = {
                'random': Random,
                'myagent': MyAgent,
            }
            \"\"\")

                with open('/kaggle/working/ARC-AGI-3-Agents/.env', 'w') as f:
                    f.write(\"\"\"SCHEME=http
            HOST=gateway
            PORT=8001
            ARC_API_KEY=test-key-123
            ARC_BASE_URL=http://gateway:8001/
            OPERATION_MODE=online
            ENVIRONMENTS_DIR=
            RECORDINGS_DIR=/kaggle/working/server_recording
            \"\"\")

                !cd /kaggle/working/ARC-AGI-3-Agents && \\
                    MPLBACKEND=agg \\
                    python main.py --agent myagent
            """
        ).replace("__OURO_MODEL_ENV_BLOCK__", env_block)
    )

    dummy_submission_cell = code_cell(
        dedent(
            """\
            import os
            if not globals().get("run_arc_agent", False):
                import pandas as pd
                submission = pd.DataFrame(
                    data=[["1_0", "1", True, 1]],
                    columns=["row_id", "game_id", "end_of_game", "score"],
                )
                submission.to_parquet("/kaggle/working/submission.parquet", index=False)
                submission.head()
            """
        )
    )

    return {
        "metadata": {
            "kernelspec": {
                "language": "python",
                "display_name": "Python 3",
                "name": "python3",
            },
            "language_info": {"name": "python", "file_extension": ".py"},
            "kaggle": {
                "accelerator": accel["name"],
                "isInternetEnabled": False,
                "isGpuEnabled": accel["gpu"],
                "language": "python",
                "sourceType": "notebook",
            },
        },
        "nbformat_minor": 4,
        "nbformat": 4,
        "cells": [
            markdown_cell(
                "# Ouroboros ARC-AGI-3 Qwen3.5-4B Submission\n\n"
                "Generated from `benchmarks/arc-agi-3/kaggle`."
            ),
            install_cell,
            *_package_cells(),
            input_discovery_cell,
            run_cell,
            dummy_submission_cell,
        ],
    }


def sync_metadata(meta: dict) -> bool:
    """Align kernel metadata with the built notebook variant. The model input
    must match the Qwen flag or the rerun either wastes provisioning
    (deterministic + model) or plays without its model (Qwen + no model)."""
    gpu = _ACCELERATORS[ACCELERATOR]["gpu"]
    changed = False
    if meta.get("enable_gpu") != gpu:
        meta["enable_gpu"] = gpu
        changed = True
    if meta.get("enable_internet") is not False:
        meta["enable_internet"] = False
        changed = True
    model_sources = [QWEN_MODEL_SOURCE] if submission_qwen_enabled() else []
    if meta.get("model_sources") != model_sources:
        meta["model_sources"] = model_sources
        changed = True
    dataset_sources = [QWEN_RUNTIME_DATASET_SOURCE] if submission_qwen_enabled() else []
    if meta.get("dataset_sources") != dataset_sources:
        meta["dataset_sources"] = dataset_sources
        changed = True
    return changed


def main() -> None:
    NOTEBOOK_PATH.parent.mkdir(parents=True, exist_ok=True)
    NOTEBOOK_PATH.write_text(json.dumps(build(), indent=1))
    variant = "qwen-hypothesis" if submission_qwen_enabled() else "deterministic"
    print(
        f"Wrote {NOTEBOOK_PATH.relative_to(ROOT)} "
        f"with accelerator={ACCELERATOR} variant={variant}"
    )

    if METADATA_PATH.exists():
        meta = json.loads(METADATA_PATH.read_text())
        if sync_metadata(meta):
            METADATA_PATH.write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
