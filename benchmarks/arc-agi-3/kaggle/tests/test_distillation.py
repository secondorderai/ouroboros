from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class DistillationTest(unittest.TestCase):
    def test_extract_run_log_parses_actions_and_death(self) -> None:
        extractor = load_script("extract_traces")
        episode = extractor.parse_run_log(
            "\n".join(
                [
                    "[ls20-9607627b] running",
                    "tool< mcp__arc__act: #1 ACTION1 → 52 cells changed #2 ACTION6(10,12) → 0 cells changed | state → GAME_OVER",
                    "[ls20-9607627b] done: state=GAME_OVER score=1 stop=error",
                ]
            )
        )
        self.assertEqual(episode.game, "ls20-9607627b")
        self.assertEqual(len(episode.actions), 2)
        self.assertEqual((episode.actions[1].action, episode.actions[1].x, episode.actions[1].y), (6, 10, 12))
        self.assertEqual(episode.actions[0].outcome, "death")
        self.assertEqual(episode.score, 1)

    def test_distiller_outputs_generic_valid_cards(self) -> None:
        distiller = load_script("distill_skills")
        cards = distiller.distill_skill_cards(
            [
                {
                    "actions": [
                        {"action": 6, "changed": 38, "outcome": "changed"},
                        {"action": 6, "changed": 0, "outcome": "no-op"},
                        {"action": 1, "changed": 52, "outcome": "death"},
                    ]
                }
            ]
        )
        self.assertTrue(any(card["executor"] == "click_board_toggle" for card in cards))
        self.assertEqual(distiller.validate_skill_cards(cards), [])

    def test_compile_agent_skills_reads_skill_md_source(self) -> None:
        compiler = load_script("compile_skills")
        cards, errors = compiler.compile_agent_skills(ROOT / "skills")
        self.assertEqual(errors, [])
        executors = {card["executor"] for card in cards}
        self.assertEqual(
            executors,
            {"movement_bfs", "click_board_toggle", "salient_click_probe", "frontier_explore"},
        )

    def test_compile_rejects_game_id_frame_hash_and_static_macro(self) -> None:
        compiler = load_script("compile_skills")
        with tempfile.TemporaryDirectory() as tmp:
            skill_dir = Path(tmp) / "bad-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                """---
name: bad-skill
description: Bad skill.
license: Apache-2.0
executor: frontier_explore
triggers:
  - simple_actions_available
priority: 1
metadata:
  author: test
  version: "1.0"
---

# Bad Skill

This memorizes ls20-9607627b at deadbeefdeadbeefdeadbeefdeadbeef.
L1 macro: A1 A2 A3 A4 A1 A2.
"""
            )
            _cards, errors = compiler.compile_agent_skills(Path(tmp))
        self.assertTrue(any("contains game id" in error for error in errors))
        self.assertTrue(any("contains frame hash" in error for error in errors))
        self.assertTrue(any("macro-like" in error for error in errors))

    def test_distiller_writes_agent_skills_and_compiled_json(self) -> None:
        distiller = load_script("distill_skills")
        with tempfile.TemporaryDirectory() as tmp:
            skills_dir = Path(tmp) / "skills"
            out = Path(tmp) / "distilled_skills.json"
            distiller.write_agent_skills(
                distiller.distilled_seeds(
                    [{"actions": [{"action": 6, "outcome": "changed"}]}]
                ),
                skills_dir,
            )
            cards, errors = distiller.compile_agent_skills(skills_dir)
            self.assertEqual(errors, [])
            distiller.write_compiled_cards(cards, out)
            self.assertTrue((skills_dir / "click-board-toggle" / "SKILL.md").exists())
            self.assertTrue(out.exists())
            self.assertTrue(any(card["id"] == "click-board-toggle" for card in cards))


if __name__ == "__main__":
    unittest.main()
