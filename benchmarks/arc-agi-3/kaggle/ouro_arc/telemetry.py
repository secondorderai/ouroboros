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
        self.count = 0
        self.last_score = 0

    def _default_path(self) -> str:
        kaggle_working = Path("/kaggle/working")
        if kaggle_working.exists():
            return str(kaggle_working / "ouro_arc_trace.jsonl")
        return str(Path.cwd() / "logs" / "ouro_arc_trace.jsonl")

    def write(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
        except OSError:
            return

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
