from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.view_trace import detect_click_cycles, load_events, summarize, write_html


def event(game_id: str, before: str, after: str, x: int, y: int) -> dict:
    return {
        "game_id": game_id,
        "before": {"key": before, "level": 0, "state": "NOT_FINISHED"},
        "after": {"key": after, "level": 0, "state": "NOT_FINISHED"},
        "action": {"action": 6, "x": x, "y": y, "source": "controller"},
        "solver": "controller",
        "outcome": "changed",
        "diff": "1 cell changed",
        "frames": {"after": [[0, 1], [2, 3]]},
    }


class TraceViewerTest(unittest.TestCase):
    def test_loads_filters_and_summarizes_trace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.jsonl"
            rows = [
                event("ft09", "a", "b", 1, 1),
                event("ft09", "b", "a", 2, 2),
                event("s5i5", "x", "y", 3, 3),
            ]
            path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")

            events = load_events(path, "ft09")
            summary = summarize(events)

            self.assertEqual(len(events), 2)
            self.assertIn("events=2", summary)
            self.assertIn("controller:2", summary)

    def test_detects_repeated_click_state_cycles(self) -> None:
        rows = [
            event("ft09", "a", "b", 1, 1),
            event("ft09", "b", "a", 2, 2),
            event("ft09", "a", "b", 1, 1),
            event("ft09", "b", "a", 2, 2),
        ]
        cycles = detect_click_cycles(rows)
        self.assertTrue(cycles)
        self.assertEqual(cycles[0][0], ("b", "a"))

    def test_writes_html_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "trace.html"
            write_html([event("ft09", "a", "b", 1, 1)], output)
            html = output.read_text()
            self.assertIn("OURO ARC Trace", html)
            self.assertIn("ACTION6(1,1)", html)
            self.assertIn("grid-template-columns", html)


if __name__ == "__main__":
    unittest.main()
