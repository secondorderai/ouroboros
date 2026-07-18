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
    model_uses_quantization,
    model_within_vram_budget,
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
                    "compute_capability": list(torch.cuda.get_device_capability(0)),
                }
            )
    except Exception as exc:
        info["torch_error"] = repr(exc)
    try:
        import transformers  # type: ignore

        info["transformers"] = transformers.__version__
    except Exception as exc:
        info["transformers_error"] = repr(exc)
    info["optimized_linear_attention"] = bool(
        importlib.util.find_spec("fla") and importlib.util.find_spec("causal_conv1d")
    )
    return info


def configure_mode(
    think: bool,
    max_calls: int,
    *,
    max_new_tokens: int | None = None,
) -> None:
    os.environ.pop("OURO_ARC_DISABLE_MODEL", None)
    config_path = os.getenv(
        "OURO_ARC_MODEL_CONFIG",
        str(ROOT / "config" / "qwen_candidate.json"),
    )
    config = load_qwen_config(config_path)
    generation_profile = config.get(
        "thinking_generation" if think else "nonthinking_generation",
        {},
    )
    if isinstance(generation_profile, dict):
        config.update(generation_profile)
    validation_max_calls = os.getenv("OURO_ARC_VALIDATION_MAX_CALLS", "").strip()
    validation_max_new_tokens = os.getenv(
        "OURO_ARC_VALIDATION_MAX_NEW_TOKENS", ""
    ).strip()
    if validation_max_calls:
        max_calls = int(validation_max_calls)
    elif config.get("world_model_mode") == "autonomous-python":
        max_calls = max(max_calls, int(config.get("max_calls", 4)))
    config["think"] = think
    config["max_calls"] = max_calls
    configured_tokens = int(config.get("max_new_tokens", 4096))
    config["max_new_tokens"] = (
        max_new_tokens
        if max_new_tokens is not None
        else int(validation_max_new_tokens)
        if validation_max_new_tokens
        else configured_tokens
        if think
        else min(configured_tokens, 512)
    )
    apply_qwen_config(config, backend="transformers", overwrite=True)
    os.environ["OURO_ARC_MODEL_REQUIRE_CUDA"] = "1"


def advisor_smoke_payload(
    advisor: Any,
    grid: list[list[int]],
    available_actions: set[int],
) -> dict[str, Any]:
    """Execute one explicit multimodal call independent of controller policy."""

    from ouro_arc.vlm_render import grid_to_png_bytes

    if os.getenv("OURO_ARC_WORLD_MODEL_MODE", "observed") == "autonomous-python":
        schema = {
            "type": "object",
            "properties": {"status": {"type": "string"}},
            "required": ["status"],
            "additionalProperties": False,
        }
        image = grid_to_png_bytes(grid)
        result = advisor.complete_json(
            "Inspect the attached ARC frame and return status=ready.",
            schema,
            image=image,
            purpose="autonomous-smoke",
        )
        diagnostics = advisor.diagnostics()
        return {
            "parseable": isinstance(result, dict) and result.get("status") == "ready",
            "plan": result,
            "model": diagnostics,
        }
    prompt = (
        "Game=ls20. Rank these supplied deterministic mechanic hypotheses for "
        "the attached initial frame: h-a1-xn-yn predicts action 1 changes the "
        "scene; h-a2-xn-yn predicts action 2 changes the scene. Return only a "
        "hypothesis AdvisorPlan using those ids and an empty actions list."
    )
    image = grid_to_png_bytes(grid)
    plan = advisor.advise(prompt, available_actions, image=image)
    diagnostics = advisor.diagnostics()
    return {
        "parseable": plan is not None,
        "plan": (
            {
                "mode": plan.mode,
                "hypothesis": plan.hypothesis,
                "ranked_hypotheses": list(plan.ranked_hypotheses),
                "confidence": plan.confidence,
            }
            if plan is not None
            else None
        ),
        "model": diagnostics,
    }


def run_model_smoke(seed: int) -> dict[str, Any]:
    configure_mode(think=False, max_calls=1, max_new_tokens=1024)
    from arc_agi import Arcade, OperationMode  # type: ignore
    from ouro_arc.advisor import ModelAdvisor
    from ouro_arc.render import last_grid

    environments_dir = os.getenv(
        "OURO_ARC_ENVIRONMENTS_DIR",
        str(ROOT / "environment_files"),
    )
    arc = Arcade(
        operation_mode=OperationMode.OFFLINE,
        environments_dir=environments_dir,
    )
    env = arc.make("ls20", seed=seed)
    if env is None:
        return {
            "label": "smoke",
            "thinking": False,
            "seed": seed,
            "games": [{"game_id": "ls20", "error": "environment unavailable"}],
            "model": {},
            "parseable": False,
            "fatal_model_failures": 1,
            "oom_failures": 0,
        }

    advisor = ModelAdvisor(require_model=True, max_new_tokens=1024)
    error = ""
    payload: dict[str, Any] = {"model": {}, "parseable": False, "plan": None}
    started = time.monotonic()
    try:
        frame = env.reset()
        grid = last_grid(getattr(frame, "frame", []) or [])
        available_actions = {
            int(getattr(action, "value", action))
            for action in (getattr(frame, "available_actions", []) or [])
        }
        payload = advisor_smoke_payload(advisor, grid, available_actions)
    except Exception as exc:
        error = repr(exc)
        payload["model"] = advisor.diagnostics()
        print(f"Qwen GPU smoke call failed: {error}")
    failure = str(payload.get("model", {}).get("failure_reason", "") or "")
    combined_error = f"{error} {failure}".lower()
    return {
        "label": "smoke",
        "thinking": False,
        "seed": seed,
        "runtime_seconds": time.monotonic() - started,
        "games": [
            {
                "game_id": "ls20",
                "initial_frame": True,
                **({"error": error} if error else {}),
            }
        ],
        **payload,
        "fatal_model_failures": int(bool(error or failure)),
        "oom_failures": int("out of memory" in combined_error),
    }


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
    model_runtime: dict[str, Any] = {}
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
        for key in (
            "model_class",
            "model_type",
            "quantization_method",
            "quantization_dequantized",
            "quantization_active",
            "fp8_module_count",
            "unscaled_fp8_linear_count",
            "unscaled_fp8_linear_examples",
            "parameter_dtype_numels",
            "parameter_device_numels",
            "peak_vram_bytes",
        ):
            if key in diagnostics:
                model_runtime[key] = diagnostics[key]
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
                "controller_actions_issued": int(agent.controller.issued_actions),
                "transitions_observed": int(agent.controller.observed_transitions),
                "autonomous_actions": int(agent.controller.autonomous_actions),
                "resets": int(agent.controller.reset_count),
                "solver_counts": dict(agent.controller.solver_counts),
                "model_calls": int(agent.controller.model_calls),
                "model_plans": int(agent.controller.model_plans),
                "autonomous_world_model": (
                    agent.controller.autonomous_model.summary()
                    if agent.controller.autonomous_model is not None
                    else {"enabled": False}
                ),
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
            **model_runtime,
            "call_attempts": call_attempts,
            "call_successes": call_successes,
            "call_latencies": all_latencies,
            "empty_content_responses": empty_content,
        },
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    model_family = str(report.get("candidate_config", {}).get("model_family", "Qwen"))
    lines = [
        f"# {model_family} RTX 6000 Validation",
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
    candidate_config = load_qwen_config(
        os.getenv("OURO_ARC_MODEL_CONFIG", str(ROOT / "config" / "qwen_candidate.json"))
    )
    validation_max_calls = os.getenv("OURO_ARC_VALIDATION_MAX_CALLS", "").strip()
    validation_max_new_tokens = os.getenv(
        "OURO_ARC_VALIDATION_MAX_NEW_TOKENS", ""
    ).strip()
    if validation_max_calls:
        candidate_config["max_calls"] = int(validation_max_calls)
    if validation_max_new_tokens:
        candidate_config["max_new_tokens"] = int(validation_max_new_tokens)
    report: dict[str, Any] = {
        "evaluation_scope": "public-set-optimization",
        "stage": stage,
        "seed": seed,
        "hardware": hardware,
        "baseline_score": BASELINE_SCORE,
        "local_qwen_score": LOCAL_QWEN_SCORE,
        "model_path": os.getenv("OURO_ARC_MODEL_PATH", ""),
        "candidate_config": candidate_config,
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
    smoke = run_model_smoke(seed)
    report["smoke"] = smoke
    smoke_model = smoke["model"]
    expected_quantization = str(candidate_config.get("expected_quant_method", ""))
    max_peak_vram_bytes = int(
        float(candidate_config.get("validation_max_peak_vram_gb", 0) or 0)
        * 1024**3
    )
    quantization_ok = model_uses_quantization(smoke_model, expected_quantization)
    scaled_fp8_ok = (
        expected_quantization.casefold() != "fp8"
        or int(smoke_model.get("unscaled_fp8_linear_count", 0)) == 0
    )
    vram_ok = model_within_vram_budget(smoke_model, max_peak_vram_bytes)
    smoke_ok = (
        int(smoke_model["call_attempts"]) >= 1
        and int(smoke_model["call_successes"]) >= 1
        and bool(smoke.get("parseable"))
        and model_is_cuda_only(smoke_model)
        and quantization_ok
        and scaled_fp8_ok
        and vram_ok
        and not smoke["fatal_model_failures"]
        and not smoke["oom_failures"]
    )
    report["smoke_gates"] = {
        "cuda_only": model_is_cuda_only(smoke_model),
        "expected_quantization": expected_quantization,
        "quantization_ok": quantization_ok,
        "scaled_fp8_ok": scaled_fp8_ok,
        "max_peak_vram_bytes": max_peak_vram_bytes,
        "vram_ok": vram_ok,
    }
    report["smoke_passed"] = smoke_ok
    print("QWEN_GPU_SMOKE=" + json.dumps(smoke, sort_keys=True, default=str))
    print(
        "QWEN_GPU_SMOKE_GATES="
        + json.dumps(report["smoke_gates"], sort_keys=True, default=str)
    )

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
