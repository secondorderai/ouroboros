from __future__ import annotations

import json
import os
from pathlib import Path
from textwrap import dedent


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "notebooks" / "gpu-validation"
NOTEBOOK = OUTPUT / "gpu-validation.ipynb"
METADATA = OUTPUT / "kernel-metadata.json"
DEFAULT_KERNEL_ID = "kinwochan/ouroboros-qwen3-5-4b-rtx-6000-public-validation"
DEFAULT_DATASET_ID = "kinwochan/ouroboros-arc-gpu-validation-assets"
MODEL_SOURCE = "kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1"
RTX_6000_MACHINE_SHAPE = "NvidiaRtxPro6000"
VALIDATION_STAGES = {"smoke", "pilot", "full"}


def code_cell(source: str) -> dict[str, object]:
    return {
        "cell_type": "code",
        "metadata": {"trusted": True},
        "outputs": [],
        "execution_count": None,
        "source": source,
    }


def markdown_cell(source: str) -> dict[str, object]:
    return {"cell_type": "markdown", "metadata": {}, "source": source}


def build_notebook(
    dataset_id: str,
    validation_stage: str = "smoke",
    selected_mode: str = "",
) -> dict[str, object]:
    if validation_stage not in VALIDATION_STAGES:
        raise ValueError(f"invalid validation stage: {validation_stage}")
    if selected_mode not in {"", "thinking_off", "thinking_on"}:
        raise ValueError(f"invalid selected mode: {selected_mode}")
    dataset_slug = dataset_id.split("/", 1)[-1]
    dataset_path = f"/kaggle/input/{dataset_slug}"
    preflight = code_cell(
        dedent(
            """\
            import json
            import platform
            import subprocess

            import torch

            preflight_path = "/kaggle/working/qwen_gpu_preflight.json"
            preflight = {
                "python": platform.python_version(),
                "torch": torch.__version__,
                "cuda_available": bool(torch.cuda.is_available()),
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
                "stage": "hardware",
            }
            nvidia_smi = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                check=False,
            )
            preflight["nvidia_smi"] = nvidia_smi.stdout.strip()
            preflight["nvidia_smi_error"] = nvidia_smi.stderr.strip()
            with open(preflight_path, "w", encoding="utf-8") as handle:
                json.dump(preflight, handle, indent=2, sort_keys=True)
                handle.write("\\n")
            print(json.dumps(preflight, indent=2, sort_keys=True))
            if not preflight["cuda_available"] or "RTX PRO 6000" not in preflight["gpu"].upper():
                raise RuntimeError(
                    "RTX PRO 6000 hardware gate failed: " + repr(preflight["gpu"])
                )
            """
        )
    )
    prepare_inputs = code_cell(
        dedent(
            """\
            import glob
            import os
            import shutil

            input_root = "/kaggle/working/qwen-validation-inputs"
            shutil.rmtree(input_root, ignore_errors=True)
            os.makedirs(input_root, exist_ok=True)
            expanded_wheels = glob.glob(
                "/kaggle/input/**/transformers-5.12.0-py3-none-any.whl",
                recursive=True,
            )
            expanded_runners = glob.glob(
                "/kaggle/input/**/scripts/run_gpu_validation.py",
                recursive=True,
            )
            wheel_archives = glob.glob("/kaggle/input/**/wheelhouse.zip", recursive=True)
            asset_archives = glob.glob("/kaggle/input/**/validation-assets.zip", recursive=True)
            wheelhouse = os.path.join(input_root, "wheelhouse")
            assets_dir = os.path.join(input_root, "validation-assets")
            if expanded_wheels and expanded_runners:
                expanded_wheelhouse = os.path.dirname(expanded_wheels[0])
                expanded_assets = os.path.dirname(os.path.dirname(expanded_runners[0]))
                shutil.copytree(expanded_wheelhouse, wheelhouse)
                shutil.copytree(expanded_assets, assets_dir)
            elif wheel_archives and asset_archives:
                shutil.unpack_archive(wheel_archives[0], wheelhouse)
                shutil.unpack_archive(asset_archives[0], assets_dir)
            else:
                raise FileNotFoundError(
                    "attached Qwen validation assets were not found under /kaggle/input"
                )
            print("wheelhouse=", wheelhouse)
            print("validation assets=", assets_dir)
            """
        )
    )
    install = code_cell(
        dedent(
            """\
            import glob
            import os

            wheel_candidates = glob.glob(
                "/kaggle/working/qwen-validation-inputs/**/transformers-5.12.0-py3-none-any.whl",
                recursive=True,
            )
            if not wheel_candidates:
                raise FileNotFoundError("extracted validation wheelhouse was not found")
            wheelhouse = os.path.dirname(wheel_candidates[0])
            print("wheelhouse=", wheelhouse)

            !pip install --no-index --no-deps \\
                --find-links $wheelhouse \\
                --find-links /kaggle/input/competitions/arc-prize-2026-arc-agi-3/arc_agi_3_wheels \\
                arc-agi arcengine python-dotenv pandas pyarrow \
                "transformers==5.12.0" "accelerate==1.10.1"
            """
        )
    )
    unpack = code_cell(
        dedent(
            """\
            import glob
            import os
            import shutil

            runner_candidates = glob.glob(
                "/kaggle/working/qwen-validation-inputs/**/scripts/run_gpu_validation.py",
                recursive=True,
            )
            if not runner_candidates:
                raise FileNotFoundError("extracted validation assets were not found")
            assets_dir = os.path.dirname(os.path.dirname(runner_candidates[0]))
            workdir = "/kaggle/working/ouro-gpu-validation"
            shutil.rmtree(workdir, ignore_errors=True)
            shutil.copytree(assets_dir, workdir)
            print("validation assets=", assets_dir)
            print("validation workdir=", workdir)
            """
        )
    )
    run = code_cell(
        dedent(
            """\
            import glob
            import os
            import runpy
            import sys

            workdir = "/kaggle/working/ouro-gpu-validation"
            sys.path.insert(0, workdir)
            os.environ["OURO_ARC_VALIDATION_STAGE"] = "__VALIDATION_STAGE__"
            os.environ["OURO_ARC_VALIDATION_SELECTED_MODE"] = "__SELECTED_MODE__"
            os.environ["OURO_ARC_VALIDATION_SEED"] = "0"
            os.environ["OURO_ARC_VALIDATION_RESULTS"] = "/kaggle/working/qwen_gpu_validation.json"
            os.environ["OURO_ARC_VALIDATION_BASELINE"] = workdir + "/baselines/deterministic_public_v11.json"
            os.environ["OURO_ARC_VALIDATION_TRACE_DIR"] = "/kaggle/working/traces"
            os.environ["OURO_ARC_ENVIRONMENTS_DIR"] = workdir + "/environment_files"
            os.environ["OURO_ARC_AGENT_PATH"] = workdir + "/agent/my_agent.py"
            os.environ["OURO_ARC_MODEL_CONFIG"] = workdir + "/config/qwen_candidate.json"
            model_configs = glob.glob(
                "/kaggle/input/models/kinwochan/qwen-3-5-4b/**/config.json",
                recursive=True,
            )
            if not model_configs:
                raise FileNotFoundError("attached Qwen3.5-4B model was not found under /kaggle/input")
            os.environ["OURO_ARC_MODEL_PATH"] = os.path.dirname(model_configs[0])
            print("OURO_ARC_MODEL_PATH=", os.environ["OURO_ARC_MODEL_PATH"])
            os.environ["OURO_ARC_MODEL_BACKEND"] = "transformers"
            os.environ["OURO_ARC_MODEL_REQUIRE_CUDA"] = "1"
            os.environ["OURO_ARC_MODEL_SERIALIZE_INFERENCE"] = "1"
            os.environ["OURO_ARC_VALIDATION_EXPECT_GPU"] = "RTX PRO 6000"
            runpy.run_path(workdir + "/scripts/run_gpu_validation.py", run_name="__main__")
            """
        )
        .replace("__VALIDATION_STAGE__", validation_stage)
        .replace("__SELECTED_MODE__", selected_mode)
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
                "accelerator": RTX_6000_MACHINE_SHAPE,
                "isInternetEnabled": False,
                "isGpuEnabled": True,
                "language": "python",
                "sourceType": "notebook",
            },
        },
        "nbformat_minor": 4,
        "nbformat": 4,
        "cells": [
            markdown_cell("# Ouroboros Qwen3.5-4B RTX 6000 Public-Game Validation"),
            preflight,
            prepare_inputs,
            install,
            unpack,
            run,
        ],
    }


def build_metadata(kernel_id: str, dataset_id: str) -> dict[str, object]:
    return {
        "id": kernel_id,
        "title": "Ouroboros Qwen3.5-4B RTX 6000 Public Validation",
        "code_file": NOTEBOOK.name,
        "language": "python",
        "kernel_type": "notebook",
        "is_private": True,
        "enable_gpu": True,
        "machine_shape": RTX_6000_MACHINE_SHAPE,
        "enable_internet": False,
        "dataset_sources": [dataset_id],
        "competition_sources": ["arc-prize-2026-arc-agi-3"],
        "model_sources": [MODEL_SOURCE],
    }


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    kernel_id = os.getenv("OURO_ARC_KAGGLE_GPU_KERNEL_ID", DEFAULT_KERNEL_ID)
    dataset_id = os.getenv("OURO_ARC_KAGGLE_GPU_DATASET_ID", DEFAULT_DATASET_ID)
    validation_stage = os.getenv("OURO_ARC_VALIDATION_STAGE", "smoke")
    selected_mode = os.getenv("OURO_ARC_VALIDATION_SELECTED_MODE", "")
    NOTEBOOK.write_text(
        json.dumps(
            build_notebook(dataset_id, validation_stage, selected_mode),
            indent=1,
        ),
        encoding="utf-8",
    )
    METADATA.write_text(
        json.dumps(build_metadata(kernel_id, dataset_id), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {NOTEBOOK}")
    print(f"Wrote {METADATA}")


if __name__ == "__main__":
    main()
