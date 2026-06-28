from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ouro_arc.telemetry import TelemetryWriter


class TelemetryWriterTest(unittest.TestCase):
    def test_writes_jsonl_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.jsonl"
            writer = TelemetryWriter(path=str(path))
            event = {
                "action": {"action": 1, "source": "probe"},
                "before": {"level": 0, "state": "NOT_FINISHED"},
                "after": {"level": 0, "state": "NOT_FINISHED"},
                "solver": "probe",
                "score_changed": False,
            }
            writer.write(event)
            rows = path.read_text().splitlines()
            self.assertEqual(len(rows), 1)
            self.assertEqual(json.loads(rows[0])["solver"], "probe")

    def test_write_errors_are_nonfatal(self) -> None:
        writer = TelemetryWriter(path="/dev/null/trace.jsonl")
        writer.write({"action": {"action": 1}})


if __name__ == "__main__":
    unittest.main()
