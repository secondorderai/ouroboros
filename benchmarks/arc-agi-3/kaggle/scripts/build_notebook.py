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

GEMMA_MODEL_SOURCE = "google/gemma-4/transformers/gemma-4-12b-it/2"

# The default submission is deterministic-only: Gemma-active reruns scored 0.00
# (submission versions 7 and 8) when advisor failures were fatal. Advisor
# failures now degrade to deterministic play, but Gemma stays opt-in per build.
DETERMINISTIC_ENV_BLOCK = dedent(
    """\
    # Deterministic submission: Gemma disabled on every path, including
    # competition reruns. Build with OURO_ARC_SUBMISSION_GEMMA=1 for the
    # Gemma-sparse variant.
    os.environ["OURO_ARC_DISABLE_MODEL"] = "1"
    os.environ["OURO_ARC_GEMMA_POLICY"] = "off"
    os.environ["OURO_ARC_GEMMA_MAX_CALLS"] = "0"
    """
).rstrip("\n")

GEMMA_ENV_BLOCK = dedent(
    """\
    # Gemma-sparse variant (built with OURO_ARC_SUBMISSION_GEMMA=1). Advisor
    # load/inference failures are non-fatal and fall back to the deterministic
    # controller; call count is capped per game.
    os.environ["OURO_ARC_GEMMA_POLICY"] = "sparse"
    os.environ["OURO_ARC_GEMMA_MAX_CALLS"] = "12"
    """
).rstrip("\n")


def submission_gemma_enabled() -> bool:
    return os.getenv("OURO_ARC_SUBMISSION_GEMMA", "").lower() in {"1", "true", "yes"}

ROOT = Path(__file__).resolve().parents[1]
AGENT_SRC = ROOT / "agent" / "my_agent.py"
PACKAGE_DIR = ROOT / "ouro_arc"
NOTEBOOK_PATH = ROOT / "notebooks" / "submission.ipynb"
METADATA_PATH = ROOT / "notebooks" / "kernel-metadata.json"


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
    env_block = GEMMA_ENV_BLOCK if submission_gemma_enabled() else DETERMINISTIC_ENV_BLOCK

    install_cell = code_cell(
        "!pip install --no-index --find-links \\\n"
        "    /kaggle/input/competitions/arc-prize-2026-arc-agi-3/arc_agi_3_wheels \\\n"
        "    arc-agi python-dotenv pandas pyarrow"
    )

    input_discovery_cell = code_cell(
        dedent(
            """\
            import os

            print("KAGGLE_IS_COMPETITION_RERUN=", os.getenv("KAGGLE_IS_COMPETITION_RERUN"))
            print("OURO_ARC_MODEL_PATH=", os.getenv("OURO_ARC_MODEL_PATH"))
            print("Discovering Gemma-like paths under /kaggle/input:")
            found_gemma_paths = []
            if os.path.exists("/kaggle/input"):
                for root, dirs, files in os.walk("/kaggle/input"):
                    if "gemma" in root.lower():
                        found_gemma_paths.append(root)
                        print(root)
                print(f"Found {len(found_gemma_paths)} Gemma-like directories")
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
            __OURO_GEMMA_ENV_BLOCK__
            os.environ.setdefault("OURO_ARC_GEMMA_INTERVAL", "16")
            os.environ.setdefault("OURO_ARC_MAX_ACTIONS", "320")
            print("competition_rerun_detected=", competition_rerun_detected)
            print("gateway_available=", gateway_up)
            print("selected_execution_path=", selected_execution_path)
            write_run_summary(
                competition_rerun_detected=competition_rerun_detected,
                gateway_available=gateway_up,
                selected_execution_path=selected_execution_path,
                disable_model=os.getenv("OURO_ARC_DISABLE_MODEL"),
                gemma_policy=os.getenv("OURO_ARC_GEMMA_POLICY"),
                gemma_max_calls=os.getenv("OURO_ARC_GEMMA_MAX_CALLS"),
                gemma_interval=os.getenv("OURO_ARC_GEMMA_INTERVAL"),
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
        ).replace("__OURO_GEMMA_ENV_BLOCK__", env_block)
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
                "# Ouroboros ARC-AGI-3 Gemma 4 12B Submission\n\n"
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
    must match the Gemma flag or the rerun either wastes provisioning
    (deterministic + model) or plays without its model (Gemma + no model)."""
    gpu = _ACCELERATORS[ACCELERATOR]["gpu"]
    changed = False
    if meta.get("enable_gpu") != gpu:
        meta["enable_gpu"] = gpu
        changed = True
    if meta.get("enable_internet") is not False:
        meta["enable_internet"] = False
        changed = True
    model_sources = [GEMMA_MODEL_SOURCE] if submission_gemma_enabled() else []
    if meta.get("model_sources") != model_sources:
        meta["model_sources"] = model_sources
        changed = True
    return changed


def main() -> None:
    NOTEBOOK_PATH.parent.mkdir(parents=True, exist_ok=True)
    NOTEBOOK_PATH.write_text(json.dumps(build(), indent=1))
    variant = "gemma-sparse" if submission_gemma_enabled() else "deterministic"
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
