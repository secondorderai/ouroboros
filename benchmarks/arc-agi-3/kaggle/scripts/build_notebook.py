from __future__ import annotations

import json
from pathlib import Path
from textwrap import dedent


ACCELERATOR = "rtx6000"
_ACCELERATORS = {
    "cpu": {"name": "none", "gpu": False},
    "t4": {"name": "nvidiaTeslaT4", "gpu": True},
    "p100": {"name": "nvidiaTeslaP100", "gpu": True},
    "rtx6000": {"name": "nvidiaRtx6000", "gpu": True},
}

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
    cells.append(_writefile_cell("/tmp/my_agent.py", AGENT_SRC.read_text()))
    return cells


def build() -> dict:
    if ACCELERATOR not in _ACCELERATORS:
        raise SystemExit(f"Unknown ACCELERATOR={ACCELERATOR!r}")
    accel = _ACCELERATORS[ACCELERATOR]

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

            if os.getenv("KAGGLE_IS_COMPETITION_RERUN"):
                !curl --fail --retry 999 --retry-all-errors --retry-delay 5 \\
                      --retry-max-time 600 http://gateway:8001/api/games

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
        )
    )

    dummy_submission_cell = code_cell(
        dedent(
            """\
            import os
            if not os.getenv("KAGGLE_IS_COMPETITION_RERUN"):
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


def main() -> None:
    NOTEBOOK_PATH.parent.mkdir(parents=True, exist_ok=True)
    NOTEBOOK_PATH.write_text(json.dumps(build(), indent=1))
    print(f"Wrote {NOTEBOOK_PATH.relative_to(ROOT)} with accelerator={ACCELERATOR}")

    if METADATA_PATH.exists():
        meta = json.loads(METADATA_PATH.read_text())
        gpu = _ACCELERATORS[ACCELERATOR]["gpu"]
        changed = False
        if meta.get("enable_gpu") != gpu:
            meta["enable_gpu"] = gpu
            changed = True
        if meta.get("enable_internet") is not False:
            meta["enable_internet"] = False
            changed = True
        if changed:
            METADATA_PATH.write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
