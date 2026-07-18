from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ouro_arc.world_model import ExecutableWorldModel, perceive_grid
from scripts.replay_world_model import load_records, replay_summary


class ReplayWorldModelTest(unittest.TestCase):
    def test_trace_replay_is_deterministic_without_arc_or_llm(self) -> None:
        before_grid = [[0, 0, 0], [0, 2, 0], [0, 0, 0]]
        after_grid = [[0, 0, 0], [0, 0, 2], [0, 0, 0]]
        model = ExecutableWorldModel()
        model.observe(
            0,
            "before",
            (1, None, None),
            "after",
            "changed",
            "gameplay-change",
            perceive_grid(before_grid),
            perceive_grid(after_grid),
        )
        event = {
            "controller": {
                "world_model": {"last_record": model.records[0].to_json()}
            }
        }

        with tempfile.TemporaryDirectory() as tmp:
            trace = Path(tmp) / "trace.jsonl"
            trace.write_text(json.dumps(event) + "\n", encoding="utf-8")
            records = load_records(trace)

        first = replay_summary(records)
        second = replay_summary(records)
        self.assertEqual(first, second)
        self.assertEqual(first["observations"], 1)
        self.assertEqual(first["ambiguous_edges"], 0)
        self.assertEqual(first["prediction"]["attempts"], 0)
        self.assertEqual(len(first["mechanic_templates"]), 1)
