"""Emit notebooks/submission.ipynb + kernel-metadata.json.

Deterministic (0-call) build by default; --model attaches the Qwen model
source and enables it. Only the competition-required cells are emitted:
install from offline wheels, write the agent package, detect the
competition rerun / gateway, run the framework, else write the dummy
parquet.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = [
    "config.py", "grid.py", "timeline.py", "rules.py", "induce.py",
    "plan.py", "explore.py", "oracle.py", "director.py", "holdout.py",
    "__init__.py",
]
KERNEL_ID = "kinwochan/ouroboros-arc-agi-3-v2"
MODEL_SOURCE = "kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"
COMP = "arc-prize-2026-arc-agi-3"


def code_cell(source: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


def writefile_cell(path: str, content: str) -> dict:
    return code_cell(f"%%writefile {path}\n{content}")


RUN_CELL = '''
import os, shutil, subprocess, sys, time, urllib.request

os.environ.setdefault("MPLBACKEND", "agg")
os.environ.setdefault("OURO2_MAX_ACTIONS", "320")
{model_env}
rerun = bool(os.getenv("KAGGLE_IS_COMPETITION_RERUN"))

def gateway_up(retries, delay):
    for _ in range(retries):
        try:
            urllib.request.urlopen("http://gateway:8001/api/games", timeout=5)
            return True
        except Exception:
            time.sleep(delay)
    return False

up = gateway_up(120, 5) if rerun else gateway_up(3, 1)
run_agent = rerun or up
print(f"rerun={{rerun}} gateway={{up}} -> {{'arc-agent' if run_agent else 'dummy-submission'}}")

if run_agent:
    src = "/kaggle/input/competitions/{comp}/ARC-AGI-3-Agents"
    dst = "/kaggle/working/ARC-AGI-3-Agents"
    if not os.path.isdir(dst):
        shutil.copytree(src, dst)
    shutil.copy("/tmp/my_agent.py", f"{{dst}}/agents/templates/my_agent.py")
    if os.path.isdir(f"{{dst}}/ouro2"):
        shutil.rmtree(f"{{dst}}/ouro2")
    shutil.copytree("/tmp/ouro2", f"{{dst}}/ouro2")
    with open(f"{{dst}}/agents/__init__.py", "w") as fh:
        fh.write(
            "from .agent import Agent\\n"
            "from .templates.my_agent import MyAgent\\n"
            "AVAILABLE_AGENTS = {{'myagent': MyAgent}}\\n"
        )
    with open(f"{{dst}}/.env", "w") as fh:
        fh.write("SCHEME=http\\nHOST=gateway\\nPORT=8001\\n"
                 "ARC_API_KEY=test-key-123\\nOPERATION_MODE=online\\n")
    subprocess.run([sys.executable, "main.py", "--agent", "myagent"], cwd=dst, check=False)
else:
    import pandas as pd

    pd.DataFrame(
        [["1_0", "1", True, 1]],
        columns=["row_id", "game_id", "end_of_game", "score"],
    ).to_parquet("/kaggle/working/submission.parquet")
    print("wrote dummy submission.parquet")
'''


def build(model: bool) -> dict:
    cells = [
        code_cell(
            "%pip install --no-index --find-links "
            f"/kaggle/input/competitions/{COMP}/arc_agi_3_wheels "
            "arc-agi python-dotenv pandas pyarrow"
        ),
        code_cell("import os\nos.makedirs('/tmp/ouro2', exist_ok=True)"),
    ]
    for name in PACKAGE_FILES:
        cells.append(
            writefile_cell(f"/tmp/ouro2/{name}", (ROOT / "ouro2" / name).read_text())
        )
    cells.append(
        writefile_cell("/tmp/my_agent.py", (ROOT / "agent" / "my_agent.py").read_text())
    )
    model_env = (
        'os.environ.setdefault("OURO2_DISABLE_MODEL", "0")\n'
        'os.environ.setdefault("OURO2_MODEL_BACKEND", "transformers")\n'
        f'os.environ.setdefault("OURO2_MODEL_PATH", "/kaggle/input/models/{MODEL_SOURCE}")'
        if model
        else 'os.environ.setdefault("OURO2_DISABLE_MODEL", "1")'
    )
    cells.append(code_cell(RUN_CELL.format(model_env=model_env, comp=COMP)))
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def kernel_metadata(model: bool) -> dict:
    meta = {
        "id": KERNEL_ID,
        "title": "ouroboros-arc-agi-3-v2",
        "code_file": "submission.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": True,
        "enable_gpu": bool(model),
        "enable_internet": False,
        "competition_sources": [COMP],
        "dataset_sources": [],
        "kernel_sources": [],
        "model_sources": [MODEL_SOURCE] if model else [],
    }
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="store_true", help="attach + enable Qwen")
    parser.add_argument("--out", default=str(ROOT / "notebooks"))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "submission.ipynb").write_text(json.dumps(build(args.model), indent=1))
    (out / "kernel-metadata.json").write_text(
        json.dumps(kernel_metadata(args.model), indent=1)
    )
    variant = "model" if args.model else "deterministic"
    print(f"wrote {out}/submission.ipynb + kernel-metadata.json ({variant})")


if __name__ == "__main__":
    main()
