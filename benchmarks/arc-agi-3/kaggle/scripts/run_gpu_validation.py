from __future__ import annotations

import importlib.util
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.gpu_validation import (  # noqa: E402
    BASELINE_SCORE,
    LOCAL_QWEN_SCORE,
    PILOT_GAMES,
    PUBLIC_GAMES,
    achieved_levels,
    evaluate_promotion,
    gpu_matches_expectation,
    model_is_cuda_only,
    select_pilot_mode,
)
from ouro_arc.model_config import apply_qwen_config, load_qwen_config  # noqa: E402


def load_agent_class() -> Any:
    agent_path = Path(
        os.getenv("OURO_ARC_AGENT_PATH", str(ROOT / "agent" / "my_agent.py"))
    )
    spec = importlib.util.spec_from_file_location("ouro_gpu_validation_agent", agent_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load agent from {agent_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MyAgent


def hardware_info() -> dict[str, Any]:
    info: dict[str, Any] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    try:
        import torch  # type: ignore

        info.update(
            {
                "torch": torch.__version__,
                "cuda_available": bool(torch.cuda.is_available()),
                "cuda_version": getattr(torch.version, "cuda", None),
            }
        )
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info.update(
                {
                    "gpu": torch.cuda.get_device_name(0),
                    "gpu_memory_bytes": int(props.total_memory),
                    "bf16_supported": bool(torch.cuda.is_bf16_supported()),
                }
            )
    except Exception as exc:
        info["torch_error"] = repr(exc)
    try:
        import transformers  # type: ignore

        info["transformers"] = transformers.__version__
    except Exception as exc:
        info["transformers_error"] = repr(exc)
    return info


def configure_mode(think: bool, max_calls: int) -> None:
    os.environ.pop("OURO_ARC_DISABLE_MODEL", None)
    config_path = os.getenv(
        "OURO_ARC_MODEL_CONFIG",
        str(ROOT / "config" / "qwen_candidate.json"),
    )
    config = load_qwen_config(config_path)
    config["think"] = think
    config["max_calls"] = max_calls
    apply_qwen_config(config, backend="transformers", overwrite=True)
    os.environ["OURO_ARC_MODEL_REQUIRE_CUDA"] = "1"


def run_game_set(
    games: tuple[str, ...],
    *,
    think: bool,
    max_calls: int,
    max_steps: int,
    label: str,
    seed: int,
) -> dict[str, Any]:
    configure_mode(think, max_calls)
    from arc_agi import Arcade, OperationMode  # type: ignore

    environments_dir = os.getenv(
        "OURO_ARC_ENVIRONMENTS_DIR",
        str(ROOT / "environment_files"),
    )
    arc = Arcade(
        operation_mode=OperationMode.OFFLINE,
        environments_dir=environments_dir,
    )
    MyAgent = load_agent_class()
    MyAgent.MAX_ACTIONS = max_steps
    rows: list[dict[str, Any]] = []
    all_latencies: list[float] = []
    call_attempts = 0
    call_successes = 0
    empty_content = 0
    fatal_model_failures = 0
    oom_failures = 0
    load_seconds = 0.0
    model_device = ""
    model_device_map: dict[str, str] = {}
    started = time.monotonic()
    trace_dir = Path(os.getenv("OURO_ARC_VALIDATION_TRACE_DIR", "/kaggle/working/traces"))
    trace_dir.mkdir(parents=True, exist_ok=True)

    for index, game_id in enumerate(games, 1):
        print(f"=== {label} [{index}/{len(games)}] {game_id} think={int(think)} ===")
        os.environ["OURO_ARC_GAME_ID"] = game_id
        os.environ["OURO_ARC_TRACE"] = "1"
        os.environ["OURO_ARC_TRACE_PATH"] = str(trace_dir / f"{label}-{game_id}.jsonl")
        env = arc.make(game_id, seed=seed)
        if env is None:
            rows.append({"game_id": game_id, "error": "environment unavailable"})
            continue
        agent = MyAgent(
            card_id=f"gpu-{label}",
            game_id=game_id,
            agent_name=f"MyAgent.gpu.{label}.{game_id}",
            ROOT_URL="http://localhost",
            record=False,
            arc_env=env,
            tags=["kaggle-gpu", label, f"thinking-{int(think)}"],
        )
        game_error = ""
        try:
            agent.main()
        except Exception as exc:
            game_error = repr(exc)
            if "out of memory" in game_error.lower():
                oom_failures += 1
            else:
                fatal_model_failures += 1
            print(f"GPU validation game failed: {game_id}: {game_error}")
        advisor = agent.controller.advisor
        diagnostics = advisor.diagnostics()
        all_latencies.extend(float(value) for value in diagnostics["call_latencies"])
        call_attempts += int(diagnostics["call_attempts"])
        call_successes += int(diagnostics["call_successes"])
        empty_content += int(diagnostics["empty_content_responses"])
        load_seconds = max(load_seconds, float(diagnostics["load_seconds"]))
        if diagnostics.get("device"):
            model_device = str(diagnostics["device"])
        if diagnostics.get("device_map"):
            model_device_map = dict(diagnostics["device_map"])
        if diagnostics.get("failure_reason"):
            fatal_model_failures += 1
        if getattr(agent, "frames", None):
            final = agent.frames[-1]
            row = {
                "game_id": game_id,
                "state": str(final.state),
                "levels_completed": int(final.levels_completed),
                "max_level_reached": int(agent.controller.max_level_reached),
                "actions": int(agent.action_counter),
                "resets": int(agent.controller.reset_count),
                "solver_counts": dict(agent.controller.solver_counts),
                "model_calls": int(agent.controller.model_calls),
                "model_plans": int(agent.controller.model_plans),
                "world_model": {
                    "observations": agent.controller.world_model.observation_count,
                    "novel_observations": agent.controller.world_model.novel_observation_count,
                    "templates": len(agent.controller.world_model.mechanic_templates()),
                    "prediction": agent.controller.world_model.prediction_metrics(),
                    "probe_efficiency": {
                        "actions": agent.controller.information_probe_actions,
                        "novel": agent.controller.information_probe_novel,
                        "rate": (
                            agent.controller.information_probe_novel
                            / agent.controller.information_probe_actions
                            if agent.controller.information_probe_actions
                            else 0.0
                        ),
                    },
                },
            }
        else:
            row = {"game_id": game_id, "error": game_error or "no final frame"}
        if game_error:
            row["error"] = game_error
        rows.append(row)

    scorecard = arc.get_scorecard()
    return {
        "label": label,
        "thinking": think,
        "seed": seed,
        "max_steps": max_steps,
        "runtime_seconds": time.monotonic() - started,
        "score": float(getattr(scorecard, "score", 0.0) or 0.0),
        "games": rows,
        "fatal_model_failures": fatal_model_failures,
        "oom_failures": oom_failures,
        "model": {
            "load_seconds": load_seconds,
            "device": model_device,
            "device_map": model_device_map,
            "call_attempts": call_attempts,
            "call_successes": call_successes,
            "call_latencies": all_latencies,
            "empty_content_responses": empty_content,
        },
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Qwen3.5-4B RTX 6000 Validation",
        "",
        f"Stage: `{report['stage']}`",
        f"Selected mode: `{report.get('selection', {}).get('selected_mode')}`",
        f"Deterministic baseline: `{BASELINE_SCORE:.12f}`",
        f"Local Qwen baseline: `{LOCAL_QWEN_SCORE:.12f}`",
        "",
    ]
    for section in ("smoke", "pilot", "full"):
        value = report.get(section)
        if value is None:
            continue
        lines.extend([f"## {section.title()}", "", "```json", json.dumps(value, indent=2), "```", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    stage = os.getenv("OURO_ARC_VALIDATION_STAGE", "full").lower()
    if stage not in {"smoke", "pilot", "full"}:
        raise SystemExit("OURO_ARC_VALIDATION_STAGE must be smoke, pilot, or full")
    seed = int(os.getenv("OURO_ARC_VALIDATION_SEED", "0"))
    output_path = Path(
        os.getenv(
            "OURO_ARC_VALIDATION_RESULTS",
            "/kaggle/working/qwen_gpu_validation.json",
        )
    )
    baseline_path = Path(
        os.getenv(
            "OURO_ARC_VALIDATION_BASELINE",
            str(ROOT / "baselines" / "deterministic_public_v11.json"),
        )
    )
    hardware = hardware_info()
    report: dict[str, Any] = {
        "stage": stage,
        "seed": seed,
        "hardware": hardware,
        "baseline_score": BASELINE_SCORE,
        "local_qwen_score": LOCAL_QWEN_SCORE,
        "model_path": os.getenv("OURO_ARC_MODEL_PATH", ""),
        "candidate_config": load_qwen_config(
            os.getenv("OURO_ARC_MODEL_CONFIG", str(ROOT / "config" / "qwen_candidate.json"))
        ),
    }
    expected_gpu = os.getenv("OURO_ARC_VALIDATION_EXPECT_GPU", "").strip()
    if expected_gpu and not gpu_matches_expectation(hardware, expected_gpu):
        report["hardware_error"] = (
            f"expected GPU containing {expected_gpu!r}, got {hardware.get('gpu')!r}"
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        write_markdown(report, output_path.with_suffix(".md"))
        raise SystemExit(report["hardware_error"])
    overall_started = time.monotonic()
    smoke = run_game_set(
        ("ls20",),
        think=False,
        max_calls=1,
        max_steps=80,
        label="smoke",
        seed=seed,
    )
    report["smoke"] = smoke
    smoke_model = smoke["model"]
    smoke_ok = (
        int(smoke_model["call_attempts"]) >= 1
        and int(smoke_model["call_successes"]) >= 1
        and model_is_cuda_only(smoke_model)
        and not smoke["fatal_model_failures"]
        and not smoke["oom_failures"]
    )
    report["smoke_passed"] = smoke_ok

    selected_mode = os.getenv("OURO_ARC_VALIDATION_SELECTED_MODE", "").strip()
    if selected_mode not in {"", "thinking_off", "thinking_on"}:
        raise SystemExit(
            "OURO_ARC_VALIDATION_SELECTED_MODE must be thinking_off or thinking_on"
        )

    if stage in {"pilot", "full"} and smoke_ok and not selected_mode:
        pilot_results = {
            "thinking_off": run_game_set(
                PILOT_GAMES,
                think=False,
                max_calls=1,
                max_steps=320,
                label="pilot-thinking-off",
                seed=seed,
            ),
            "thinking_on": run_game_set(
                PILOT_GAMES,
                think=True,
                max_calls=1,
                max_steps=320,
                label="pilot-thinking-on",
                seed=seed,
            ),
        }
        report["pilot"] = pilot_results
        selection = select_pilot_mode(pilot_results)
        report["selection"] = selection
        selected_mode = str(selection["selected_mode"] or "")

    if stage == "full" and smoke_ok and selected_mode:
        report.setdefault(
            "selection",
            {
                "selected_mode": selected_mode,
                "source": "frozen pilot result",
            },
        )
        think = selected_mode == "thinking_on"
        full = run_game_set(
            PUBLIC_GAMES,
            think=think,
            max_calls=1,
            max_steps=320,
            label=f"full-{selected_mode}",
            seed=seed,
        )
        full["runtime_seconds"] = time.monotonic() - overall_started
        report["full"] = full
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        report["promotion"] = evaluate_promotion(full, baseline)

    report["runtime_seconds"] = time.monotonic() - overall_started
    try:
        import torch  # type: ignore

        report["hardware"]["peak_vram_bytes"] = int(torch.cuda.max_memory_allocated())
    except Exception:
        pass
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path = output_path.with_suffix(".md")
    write_markdown(report, markdown_path)
    print(f"Wrote {output_path}")
    print(f"Wrote {markdown_path}")
    if not smoke_ok:
        raise SystemExit("Qwen GPU smoke failed; pilot/full stages were not run")


if __name__ == "__main__":
    main()
