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
    "rtxpro6000": {"name": "NvidiaRtxPro6000", "gpu": True},
}

QWEN_MODEL_SOURCE = "kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"
QWEN_RUNTIME_DATASET_SOURCE = "kinwochan/ouroboros-qwen-runtime-wheels"
QWEN36_VALIDATION_DATASET_SOURCE = "kinwochan/ouroboros-arc-gpu-validation-assets"
SUBMISSION_MODEL_PROFILES = {
    "qwen35-4b": {
        "title": "Qwen3.5-4B",
        "model_family": "qwen3.5-4b",
        "model_source": QWEN_MODEL_SOURCE,
        "dataset_source": QWEN_RUNTIME_DATASET_SOURCE,
        "model_path_fragment": "qwen-3-5-4b",
        "accelerator": "rtx6000",
        "packages": ('"transformers==5.12.0"', '"accelerate==1.10.1"'),
    },
    "qwen36-27b-fp8": {
        "title": "Qwen3.6-27B-FP8",
        "model_family": "qwen3.6-27b-fp8",
        "model_source": "michaelpoluektov/qwen3-6-27b-fp8/transformers/default/1",
        "dataset_source": QWEN36_VALIDATION_DATASET_SOURCE,
        "model_path_fragment": "qwen3-6-27b-fp8",
        "accelerator": "rtxpro6000",
        "packages": (
            '"transformers==5.14.1"',
            '"accelerate==1.14.0"',
            '"safetensors==0.8.0"',
            '"kernels==0.15.2"',
            '"kernels-data==0.15.2"',
        ),
    },
}

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
    os.environ["OURO_ARC_WORLD_MODEL_MODE"] = "observed"
    os.environ["OURO_ARC_DISCOVERY_BARRIER_ENABLED"] = "0"
    """
).rstrip("\n")

def submission_qwen_enabled() -> bool:
    return os.getenv("OURO_ARC_SUBMISSION_QWEN", "").lower() in {"1", "true", "yes"}


def submission_model_profile() -> dict:
    name = os.getenv("OURO_ARC_SUBMISSION_MODEL_PROFILE", "qwen35-4b")
    if name not in SUBMISSION_MODEL_PROFILES:
        raise SystemExit(f"Unknown OURO_ARC_SUBMISSION_MODEL_PROFILE={name!r}")
    return SUBMISSION_MODEL_PROFILES[name]

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
    optional = {
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
        "OURO_ARC_DISCOVERY_PARTICIPANTS": config.get("discovery_participants", 25) if config.get("discovery_barrier") else None,
        "OURO_ARC_MODEL_DO_SAMPLE": int(bool(config.get("do_sample"))) if "do_sample" in config else None,
        "OURO_ARC_MODEL_TEMPERATURE": config.get("temperature"),
        "OURO_ARC_MODEL_TOP_P": config.get("top_p"),
        "OURO_ARC_MODEL_TOP_K": config.get("top_k"),
        "OURO_ARC_MODEL_SEED": config.get("seed"),
        "OURO_ARC_MODEL_FP8_FIX_GATE_PROJ": int(bool(config.get("fp8_fix_gate_proj"))) if "fp8_fix_gate_proj" in config else None,
        "OURO_ARC_MODEL_REQUIRE_SCALED_FP8": int(bool(config.get("require_scaled_fp8"))) if "require_scaled_fp8" in config else None,
    }
    values.update({key: value for key, value in optional.items() if value is not None})
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
    profile = submission_model_profile()
    accelerator = str(profile["accelerator"]) if submission_qwen_enabled() else ACCELERATOR
    if accelerator not in _ACCELERATORS:
        raise SystemExit(f"Unknown ACCELERATOR={accelerator!r}")
    accel = _ACCELERATORS[accelerator]
    promoted = load_promoted_config() if submission_qwen_enabled() else None
    if promoted and promoted.get("model_family", profile["model_family"]) != profile["model_family"]:
        raise SystemExit(
            "Promoted config model_family does not match "
            f"OURO_ARC_SUBMISSION_MODEL_PROFILE: {promoted.get('model_family')!r}"
        )
    env_block = (
        qwen_env_block(promoted)
        if submission_qwen_enabled()
        else DETERMINISTIC_ENV_BLOCK
    )

    runtime_cells: list[dict] = []
    if submission_qwen_enabled() and profile["model_family"] == "qwen3.6-27b-fp8":
        runtime_cells.append(
            code_cell(
                dedent(
                    """\
                    import glob
                    import os
                    import shutil

                    qwen_runtime_root = "/kaggle/working/qwen36-runtime"
                    shutil.rmtree(qwen_runtime_root, ignore_errors=True)
                    os.makedirs(qwen_runtime_root, exist_ok=True)
                    qwen_wheels = glob.glob(
                        "/kaggle/input/**/transformers-5.14.1-py3-none-any.whl",
                        recursive=True,
                    )
                    if qwen_wheels:
                        qwen_wheelhouse = os.path.dirname(qwen_wheels[0])
                    else:
                        wheel_archives = glob.glob("/kaggle/input/**/wheelhouse.zip", recursive=True)
                        if not wheel_archives:
                            raise FileNotFoundError("Qwen3.6 offline wheelhouse was not attached")
                        qwen_wheelhouse = os.path.join(qwen_runtime_root, "wheelhouse")
                        shutil.unpack_archive(wheel_archives[0], qwen_wheelhouse)

                    fp8_metadata = glob.glob(
                        "/kaggle/input/**/kernels/finegrained-fp8/build/torch-cuda/metadata.json",
                        recursive=True,
                    )
                    if not fp8_metadata:
                        asset_archives = glob.glob(
                            "/kaggle/input/**/validation-assets.zip", recursive=True
                        )
                        if not asset_archives:
                            raise FileNotFoundError("offline fine-grained FP8 kernel was not attached")
                        qwen_assets = os.path.join(qwen_runtime_root, "validation-assets")
                        shutil.unpack_archive(asset_archives[0], qwen_assets)
                        fp8_metadata = glob.glob(
                            qwen_assets + "/**/kernels/finegrained-fp8/build/torch-cuda/metadata.json",
                            recursive=True,
                        )
                    if not fp8_metadata:
                        raise FileNotFoundError("offline fine-grained FP8 kernel metadata is missing")
                    qwen_fp8_kernel = os.path.dirname(
                        os.path.dirname(os.path.dirname(fp8_metadata[0]))
                    )
                    print("qwen_wheelhouse=", qwen_wheelhouse)
                    print("qwen_fp8_kernel=", qwen_fp8_kernel)
                    """
                )
            )
        )
        install_sources = "    --find-links $qwen_wheelhouse \\\n"
    else:
        install_sources = (
            "    --find-links /kaggle/input/ouroboros-qwen-runtime-wheels \\\n"
            if submission_qwen_enabled()
            else ""
        )
    model_packages = (
        " " + " ".join(str(item) for item in profile["packages"])
        if submission_qwen_enabled()
        else ""
    )
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
            print("Discovering __MODEL_TITLE__ paths under /kaggle/input:")
            found_qwen_paths = []
            if os.path.exists("/kaggle/input"):
                for root, dirs, files in os.walk("/kaggle/input"):
                    if "__MODEL_PATH_FRAGMENT__" in root.lower() and "config.json" in files:
                        found_qwen_paths.append(root)
                        print(root)
                print(f"Found {len(found_qwen_paths)} Qwen model directories")
                if found_qwen_paths and not os.getenv("OURO_ARC_MODEL_PATH"):
                    os.environ["OURO_ARC_MODEL_PATH"] = sorted(found_qwen_paths)[0]
            else:
                print("/kaggle/input does not exist in this environment")
            __QWEN_RUNTIME_ENV__
            """
        )
        .replace("__MODEL_TITLE__", str(profile["title"]))
        .replace("__MODEL_PATH_FRAGMENT__", str(profile["model_path_fragment"]))
        .replace(
            "__QWEN_RUNTIME_ENV__",
            dedent(
                """\
                if globals().get("qwen_fp8_kernel"):
                    os.environ["TRANSFORMERS_DISABLE_DEEPGEMM_LINEAR"] = "1"
                    os.environ["LOCAL_KERNELS"] = (
                        "kernels-community/finegrained-fp8=" + qwen_fp8_kernel
                    )
                    os.environ["HF_HUB_OFFLINE"] = "1"
                """
            ).rstrip()
            if submission_qwen_enabled() and profile["model_family"] == "qwen3.6-27b-fp8"
            else "",
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
            os.environ.setdefault("OURO_ARC_GENERATED_MODEL_DIR", "/kaggle/working/generated_models")
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
                world_model_mode=os.getenv("OURO_ARC_WORLD_MODEL_MODE"),
                shared_mechanics=os.getenv("OURO_ARC_SHARED_MECHANICS"),
                discovery_barrier=os.getenv("OURO_ARC_DISCOVERY_BARRIER_ENABLED"),
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
                f"# Ouroboros ARC-AGI-3 {profile['title']} Submission\n\n"
                "Generated from `benchmarks/arc-agi-3/kaggle`."
            ),
            *runtime_cells,
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
    profile = submission_model_profile()
    accelerator = str(profile["accelerator"]) if submission_qwen_enabled() else ACCELERATOR
    gpu = _ACCELERATORS[accelerator]["gpu"]
    changed = False
    if meta.get("enable_gpu") != gpu:
        meta["enable_gpu"] = gpu
        changed = True
    if meta.get("enable_internet") is not False:
        meta["enable_internet"] = False
        changed = True
    model_sources = [str(profile["model_source"])] if submission_qwen_enabled() else []
    if meta.get("model_sources") != model_sources:
        meta["model_sources"] = model_sources
        changed = True
    dataset_sources = [str(profile["dataset_source"])] if submission_qwen_enabled() else []
    if meta.get("dataset_sources") != dataset_sources:
        meta["dataset_sources"] = dataset_sources
        changed = True
    machine_shape = _ACCELERATORS[accelerator]["name"]
    if submission_qwen_enabled() and meta.get("machine_shape") != machine_shape:
        meta["machine_shape"] = machine_shape
        changed = True
    if not submission_qwen_enabled() and "machine_shape" in meta:
        del meta["machine_shape"]
        changed = True
    return changed


def main() -> None:
    notebook_dir = Path(
        os.getenv("OURO_ARC_SUBMISSION_NOTEBOOK_DIR", str(NOTEBOOK_PATH.parent))
    )
    notebook_path = notebook_dir / "submission.ipynb"
    metadata_path = notebook_dir / "kernel-metadata.json"
    notebook_dir.mkdir(parents=True, exist_ok=True)
    notebook_path.write_text(json.dumps(build(), indent=1))
    if submission_qwen_enabled():
        promoted = load_promoted_config()
        variant = "qwen-autonomous" if promoted.get("world_model_mode") == "autonomous-python" else "qwen-hypothesis"
    else:
        variant = "deterministic"
    display_path = (
        notebook_path.relative_to(ROOT)
        if notebook_path.is_relative_to(ROOT)
        else notebook_path
    )
    profile = submission_model_profile()
    accelerator = str(profile["accelerator"]) if submission_qwen_enabled() else ACCELERATOR
    print(
        f"Wrote {display_path} "
        f"with accelerator={accelerator} variant={variant}"
    )

    if metadata_path.exists():
        meta = json.loads(metadata_path.read_text())
    else:
        meta = {
            "id": os.getenv(
                "OURO_ARC_SUBMISSION_KERNEL_ID",
                "kinwochan/ouroboros-arc-agi-3-qwen36-fp8"
                if profile["model_family"] == "qwen3.6-27b-fp8"
                else "kinwochan/ouroboros-arc-agi-3-qwen35",
            ),
            "title": os.getenv(
                "OURO_ARC_SUBMISSION_TITLE",
                "ouroboros-arc-agi-3-qwen36-fp8"
                if profile["model_family"] == "qwen3.6-27b-fp8"
                else "ouroboros-arc-agi-3-qwen35",
            ),
            "code_file": "submission.ipynb",
            "language": "python",
            "kernel_type": "notebook",
            "is_private": True,
            "enable_gpu": True,
            "enable_internet": False,
            "competition_sources": ["arc-prize-2026-arc-agi-3"],
        }
    sync_metadata(meta)
    metadata_path.write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
