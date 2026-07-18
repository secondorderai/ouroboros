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
TRANSFORMERS_VERSION = "5.14.1"
ACCELERATE_VERSION = "1.14.0"
SAFETENSORS_VERSION = "0.8.0"
KERNELS_VERSION = "0.15.2"
RTX_6000_MACHINE_SHAPE = "NvidiaRtxPro6000"
VALIDATION_STAGES = {"smoke", "pilot", "full"}
MODEL_PROFILES = {
    "qwen35-4b": {
        "title": "Qwen3.5-4B",
        "model_source": MODEL_SOURCE,
        "model_owner": "kinwochan",
        "model_slug": "qwen-3-5-4b",
        "config_name": "qwen_autonomous_candidate.json",
        "expected_quantization": "",
        "default_kernel_id": DEFAULT_KERNEL_ID,
        "output_directory": "gpu-validation",
    },
    "qwen36-27b-fp8": {
        "title": "Qwen3.6-27B-FP8",
        "model_source": (
            "michaelpoluektov/qwen3-6-27b-fp8/transformers/default/1"
        ),
        "model_owner": "michaelpoluektov",
        "model_slug": "qwen3-6-27b-fp8",
        "config_name": "qwen36_fp8_autonomous_candidate.json",
        "expected_quantization": "fp8",
        "default_kernel_id": (
            "kinwochan/ouroboros-qwen3-6-27b-fp8-rtx-validation"
        ),
        "output_directory": "gpu-validation-qwen36",
    },
}


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
    model_profile: str = "qwen35-4b",
    validation_max_calls: int | None = None,
    validation_max_new_tokens: int | None = None,
) -> dict[str, object]:
    if validation_stage not in VALIDATION_STAGES:
        raise ValueError(f"invalid validation stage: {validation_stage}")
    if selected_mode not in {"", "thinking_off", "thinking_on"}:
        raise ValueError(f"invalid selected mode: {selected_mode}")
    if model_profile not in MODEL_PROFILES:
        raise ValueError(f"invalid model profile: {model_profile}")
    profile = MODEL_PROFILES[model_profile]
    autonomous = os.getenv("OURO_ARC_GPU_AUTONOMOUS", "0").lower() in {
        "1",
        "true",
        "yes",
    }
    config_name = str(profile["config_name"])
    if model_profile == "qwen35-4b" and not autonomous:
        config_name = "qwen_candidate.json"
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
                "compute_capability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else [],
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
            if __REQUIRE_FP8__ and tuple(preflight["compute_capability"]) < (8, 9):
                raise RuntimeError(
                    "FP8 hardware gate failed: " + repr(preflight["compute_capability"])
                )
            """
        ).replace("__REQUIRE_FP8__", repr(bool(profile["expected_quantization"])))
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
                "/kaggle/input/**/transformers-__TRANSFORMERS_VERSION__-py3-none-any.whl",
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
        ).replace("__TRANSFORMERS_VERSION__", TRANSFORMERS_VERSION)
    )
    install = code_cell(
        dedent(
            """\
            import glob
            import os

            wheel_candidates = glob.glob(
                "/kaggle/working/qwen-validation-inputs/**/transformers-__TRANSFORMERS_VERSION__-py3-none-any.whl",
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
                "transformers==__TRANSFORMERS_VERSION__" \
                "accelerate==__ACCELERATE_VERSION__" \
                "safetensors==__SAFETENSORS_VERSION__" \
                "kernels==__KERNELS_VERSION__" \
                "kernels-data==__KERNELS_VERSION__"
            """
        )
        .replace("__TRANSFORMERS_VERSION__", TRANSFORMERS_VERSION)
        .replace("__ACCELERATE_VERSION__", ACCELERATE_VERSION)
        .replace("__SAFETENSORS_VERSION__", SAFETENSORS_VERSION)
        .replace("__KERNELS_VERSION__", KERNELS_VERSION)
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
            os.environ["OURO_ARC_GENERATED_MODEL_DIR"] = "/kaggle/working/generated_models"
            os.environ["OURO_ARC_ENVIRONMENTS_DIR"] = workdir + "/environment_files"
            os.environ["OURO_ARC_AGENT_PATH"] = workdir + "/agent/my_agent.py"
            os.environ["OURO_ARC_MODEL_CONFIG"] = workdir + "/config/__CONFIG_NAME__"
            os.environ["OURO_ARC_VALIDATION_MODEL_PROFILE"] = "__MODEL_PROFILE__"
            os.environ["OURO_ARC_VALIDATION_EXPECT_QUANTIZATION"] = "__EXPECTED_QUANTIZATION__"
            __VALIDATION_BUDGET__
            model_configs = glob.glob(
                "/kaggle/input/models/__MODEL_OWNER__/__MODEL_SLUG__/**/config.json",
                recursive=True,
            )
            if not model_configs:
                raise FileNotFoundError("attached __MODEL_TITLE__ model was not found under /kaggle/input")
            os.environ["OURO_ARC_MODEL_PATH"] = os.path.dirname(model_configs[0])
            print("OURO_ARC_MODEL_PATH=", os.environ["OURO_ARC_MODEL_PATH"])
            os.environ["OURO_ARC_MODEL_BACKEND"] = "transformers"
            os.environ["OURO_ARC_MODEL_REQUIRE_CUDA"] = "1"
            os.environ["OURO_ARC_MODEL_SERIALIZE_INFERENCE"] = "1"
            # DeepGEMM's `kernels` package downloads code from Hugging Face at
            # runtime. Keep this offline notebook on Transformers' Triton FP8 path.
            os.environ["TRANSFORMERS_DISABLE_DEEPGEMM_LINEAR"] = "1"
            fp8_kernel = workdir + "/kernels/finegrained-fp8"
            if not os.path.isfile(fp8_kernel + "/build/torch-cuda/metadata.json"):
                raise FileNotFoundError("offline fine-grained FP8 kernel was not packaged")
            os.environ["LOCAL_KERNELS"] = (
                "kernels-community/finegrained-fp8=" + fp8_kernel
            )
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["OURO_ARC_VALIDATION_EXPECT_GPU"] = "RTX PRO 6000"
            runpy.run_path(workdir + "/scripts/run_gpu_validation.py", run_name="__main__")
            """
        )
        .replace("__VALIDATION_STAGE__", validation_stage)
        .replace("__SELECTED_MODE__", selected_mode)
        .replace("__CONFIG_NAME__", config_name)
        .replace("__MODEL_PROFILE__", model_profile)
        .replace("__EXPECTED_QUANTIZATION__", str(profile["expected_quantization"]))
        .replace("__MODEL_OWNER__", str(profile["model_owner"]))
        .replace("__MODEL_SLUG__", str(profile["model_slug"]))
        .replace("__MODEL_TITLE__", str(profile["title"]))
        .replace(
            "__VALIDATION_BUDGET__",
            "\n".join(
                line
                for line in (
                    (
                        'os.environ["OURO_ARC_VALIDATION_MAX_CALLS"] = '
                        f'{str(validation_max_calls)!r}'
                        if validation_max_calls is not None
                        else ""
                    ),
                    (
                        'os.environ["OURO_ARC_VALIDATION_MAX_NEW_TOKENS"] = '
                        f'{str(validation_max_new_tokens)!r}'
                        if validation_max_new_tokens is not None
                        else ""
                    ),
                )
                if line
            ),
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
            markdown_cell(
                f"# Ouroboros {profile['title']} RTX 6000 Public-Game Validation"
            ),
            preflight,
            prepare_inputs,
            install,
            unpack,
            run,
        ],
    }


def build_metadata(
    kernel_id: str,
    dataset_id: str,
    model_profile: str = "qwen35-4b",
) -> dict[str, object]:
    if model_profile not in MODEL_PROFILES:
        raise ValueError(f"invalid model profile: {model_profile}")
    profile = MODEL_PROFILES[model_profile]
    return {
        "id": kernel_id,
        "title": f"Ouroboros {profile['title']} RTX Validation",
        "code_file": "gpu-validation.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": True,
        "enable_gpu": True,
        "machine_shape": RTX_6000_MACHINE_SHAPE,
        "enable_internet": False,
        "dataset_sources": [dataset_id],
        "competition_sources": ["arc-prize-2026-arc-agi-3"],
        "model_sources": [str(profile["model_source"])],
    }


def main() -> None:
    model_profile = os.getenv("OURO_ARC_GPU_MODEL_PROFILE", "qwen35-4b")
    if model_profile not in MODEL_PROFILES:
        raise SystemExit(f"invalid OURO_ARC_GPU_MODEL_PROFILE: {model_profile}")
    profile = MODEL_PROFILES[model_profile]
    output = Path(
        os.getenv(
            "OURO_ARC_GPU_NOTEBOOK_DIR",
            str(ROOT / "notebooks" / str(profile["output_directory"])),
        )
    )
    notebook_path = output / "gpu-validation.ipynb"
    metadata_path = output / "kernel-metadata.json"
    output.mkdir(parents=True, exist_ok=True)
    kernel_id = os.getenv(
        "OURO_ARC_KAGGLE_GPU_KERNEL_ID", str(profile["default_kernel_id"])
    )
    dataset_id = os.getenv("OURO_ARC_KAGGLE_GPU_DATASET_ID", DEFAULT_DATASET_ID)
    validation_stage = os.getenv("OURO_ARC_VALIDATION_STAGE", "smoke")
    selected_mode = os.getenv("OURO_ARC_VALIDATION_SELECTED_MODE", "")
    validation_max_calls = os.getenv("OURO_ARC_VALIDATION_MAX_CALLS", "").strip()
    validation_max_new_tokens = os.getenv(
        "OURO_ARC_VALIDATION_MAX_NEW_TOKENS", ""
    ).strip()
    notebook_path.write_text(
        json.dumps(
            build_notebook(
                dataset_id,
                validation_stage,
                selected_mode,
                model_profile,
                int(validation_max_calls) if validation_max_calls else None,
                int(validation_max_new_tokens) if validation_max_new_tokens else None,
            ),
            indent=1,
        ),
        encoding="utf-8",
    )
    metadata_path.write_text(
        json.dumps(build_metadata(kernel_id, dataset_id, model_profile), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {notebook_path}")
    print(f"Wrote {metadata_path}")


if __name__ == "__main__":
    main()
