from __future__ import annotations

import unittest

from ouro_arc.actions import ActionSpec, filter_legal_actions, normalize_available_actions


class ActionsTest(unittest.TestCase):
    def test_action6_requires_coordinates(self) -> None:
        with self.assertRaises(ValueError):
            ActionSpec(6).validate({6})
        ActionSpec(6, x=10, y=20).validate({6})

    def test_filter_legal_actions_drops_unavailable(self) -> None:
        actions = [ActionSpec(1), ActionSpec(4), ActionSpec(6, x=1, y=1)]
        self.assertEqual(
            [action.action for action in filter_legal_actions(actions, {1, 6})],
            [1, 6],
        )

    def test_normalize_available_actions_accepts_enum_like_values(self) -> None:
        class EnumLike:
            def __init__(self, name: str) -> None:
                self.name = name

        self.assertEqual(normalize_available_actions([1, EnumLike("ACTION6")]), {1, 6})


if __name__ == "__main__":
    unittest.main()
