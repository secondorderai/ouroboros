from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class TelemetryWriter:
    """Best-effort JSONL telemetry for Kaggle and local runs."""

    def __init__(self, path: str | None = None) -> None:
        self.enabled = os.getenv("OURO_ARC_TRACE", "1").lower() not in {"0", "false", "no"}
        self.path = Path(path or os.getenv("OURO_ARC_TRACE_PATH", self._default_path()))
        self.summary_path = Path(
            os.getenv("OURO_ARC_SUMMARY_PATH", self._default_summary_path())
        )
        self.count = 0
        self.last_score = 0

    def _default_path(self) -> str:
        kaggle_working = Path("/kaggle/working")
        if kaggle_working.exists():
            return str(kaggle_working / "ouro_arc_trace.jsonl")
        return str(Path.cwd() / "logs" / "ouro_arc_trace.jsonl")

    def _default_summary_path(self) -> str:
        kaggle_working = Path("/kaggle/working")
        if kaggle_working.exists():
            return str(kaggle_working / "ouro_arc_summary.json")
        return str(Path.cwd() / "logs" / "ouro_arc_summary.json")

    def write(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
        except OSError:
            return
        self._update_summary_from_event(event)

    def write_summary(self, summary: dict[str, Any], print_summary: bool = False) -> None:
        merged = self._read_summary()
        merged.update(summary)
        try:
            self.summary_path.parent.mkdir(parents=True, exist_ok=True)
            self.summary_path.write_text(
                json.dumps(merged, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except OSError:
            return
        if print_summary:
            print(
                "[ouro-arc] summary "
                f"actions={merged.get('action_count', 0)} "
                f"max_level={merged.get('max_level_reached', 0)} "
                f"state={merged.get('final_state', '?')} "
                f"model={merged.get('model_calls', 0)}/{merged.get('model_plans', 0)} "
                f"resets={merged.get('reset_count', 0)}"
            )

    def progress(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return
        self.count += 1
        after = event.get("after", {})
        level = int(after.get("level", 0) or 0)
        state = str(after.get("state", "?"))
        score_changed = bool(event.get("score_changed"))
        if self.count % 25 != 0 and not score_changed:
            return
        self.last_score = max(self.last_score, level)
        action = event.get("action", {})
        name = f"ACTION{action.get('action')}"
        if action.get("action") == 6:
            name += f"({action.get('x')},{action.get('y')})"
        print(
            f"[ouro-arc] step={self.count} level={level} state={state} "
            f"action={name} source={action.get('source')} solver={event.get('solver')}"
        )

    def _read_summary(self) -> dict[str, Any]:
        try:
            if self.summary_path.exists():
                raw = json.loads(self.summary_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    return raw
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def _update_summary_from_event(self, event: dict[str, Any]) -> None:
        after = event.get("after", {})
        action = event.get("action", {})
        advisor = event.get("advisor", event.get("gemma", {}))
        model = event.get("model", {})
        solver = str(event.get("solver", action.get("source", "unknown")))
        current = self._read_summary()
        solver_counts = dict(current.get("solver_counts", {}))
        solver_counts[solver] = int(solver_counts.get(solver, 0)) + 1
        level = int(after.get("level", 0) or 0)
        summary = {
            "action_count": int(current.get("action_count", 0)) + 1,
            "final_state": str(after.get("state", "?")),
            "max_level_reached": max(int(current.get("max_level_reached", 0) or 0), level),
            "reset_count": int(current.get("reset_count", 0) or 0)
            + (1 if int(action.get("action", -1) or -1) == 0 else 0),
            "model_calls": int(advisor.get("calls", current.get("model_calls", 0)) or 0),
            "model_plans": int(advisor.get("plans", current.get("model_plans", 0)) or 0),
            "model_failures": int(advisor.get("failed_calls", current.get("model_failures", 0)) or 0),
            "model_backoff_remaining": int(advisor.get("backoff_remaining", 0) or 0),
            "model_path_found": model.get("path", current.get("model_path_found")),
            "model_loaded": bool(model.get("loaded", current.get("model_loaded", False))),
            "solver_counts": solver_counts,
        }
        self.write_summary(summary)
