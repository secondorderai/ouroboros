from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec
from ouro_arc.click_board import ClickBoardModel
from ouro_arc.movement import MovementModel
from ouro_arc.skills import SkillContext, SkillRegistry, validate_skill_cards


def board_grid() -> list[list[int]]:
    grid = [[0 for _ in range(64)] for _ in range(64)]
    for y0 in (10, 18):
        for x0 in (10, 18):
            for y in range(y0, y0 + 4):
                for x in range(x0, x0 + 4):
                    grid[y][x] = 3
    return grid


class SkillRegistryTest(unittest.TestCase):
    def test_validation_rejects_brittle_public_game_keys(self) -> None:
        errors = validate_skill_cards(
            [
                {
                    "id": "bad",
                    "name": "Bad",
                    "description": "solve ls20-9607627b at hash deadbeefdeadbeefdeadbeefdeadbeef",
                    "executor": "frontier_explore",
                    "triggers": [],
                    "frame_hash": "deadbeefdeadbeefdeadbeefdeadbeef",
                }
            ]
        )
        self.assertGreaterEqual(len(errors), 2)

    def test_registry_ranks_movement_executor_when_deltas_exist(self) -> None:
        movement = MovementModel()
        movement.current_position = (1, 1)
        movement.deltas = {1: (0, -1), 2: (0, 1)}
        movement.visited_positions = {(1, 1), (1, 0)}
        context = SkillContext(
            grid=[[0 for _ in range(8)] for _ in range(8)],
            level=0,
            available_actions={1, 2},
            movement_model=movement,
            click_board=ClickBoardModel(),
            node_tried=set(),
            dud_clicks=set(),
            dangerous_edges=set(),
            noop_edges=set(),
            state_key="state",
        )
        plans = SkillRegistry().ranked_plans(context)
        self.assertEqual(plans[0].card.executor, "movement_bfs")
        self.assertEqual(plans[0].actions[0].source, "movement-bfs")

    def test_click_board_executor_proposes_regular_targets(self) -> None:
        context = SkillContext(
            grid=board_grid(),
            level=0,
            available_actions={6},
            movement_model=MovementModel(),
            click_board=ClickBoardModel(),
            node_tried=set(),
            dud_clicks=set(),
            dangerous_edges=set(),
            noop_edges=set(),
            state_key="state",
        )
        plans = SkillRegistry().ranked_plans(context)
        self.assertEqual(plans[0].card.executor, "click_board_toggle")
        self.assertEqual(plans[0].actions[0].action, 6)

    def test_executor_avoids_known_noop_edge(self) -> None:
        action = ActionSpec(1, reason="blocked", source="test")
        movement = MovementModel()
        movement.current_position = (1, 1)
        movement.deltas = {1: (0, -1)}
        context = SkillContext(
            grid=[[0 for _ in range(8)] for _ in range(8)],
            level=0,
            available_actions={1},
            movement_model=movement,
            click_board=ClickBoardModel(),
            node_tried=set(),
            dud_clicks=set(),
            dangerous_edges=set(),
            noop_edges={(0, "state", action.key)},
            state_key="state",
        )
        self.assertEqual(SkillRegistry().ranked_plans(context), [])

    def test_registry_excludes_cooled_and_banned_skills(self) -> None:
        movement = MovementModel()
        movement.current_position = (1, 1)
        movement.deltas = {1: (0, -1), 2: (0, 1)}
        movement.visited_positions = {(1, 1), (1, 0)}
        context = SkillContext(
            grid=[[0 for _ in range(8)] for _ in range(8)],
            level=0,
            available_actions={1, 2},
            movement_model=movement,
            click_board=ClickBoardModel(),
            node_tried=set(),
            dud_clicks=set(),
            dangerous_edges=set(),
            noop_edges=set(),
            state_key="state",
            cooled_skills={"movement-bfs-frontier"},
            banned_skills={"frontier-simple-explore"},
        )
        plans = SkillRegistry().ranked_plans(context)
        self.assertTrue(all(plan.card.id != "movement-bfs-frontier" for plan in plans))
        self.assertTrue(all(plan.card.id != "frontier-simple-explore" for plan in plans))


if __name__ == "__main__":
    unittest.main()
