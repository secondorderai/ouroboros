from __future__ import annotations

import unittest

from ouro_arc.transition_graph import TransitionGraph


A1 = (1, None, None)
A2 = (2, None, None)
A3 = (3, None, None)
CLICK = (6, 5, 7)


def never_blocked(_action_key: object) -> bool:
    return False


class TransitionGraphTest(unittest.TestCase):
    def test_observe_records_score_edge_and_counts_visits(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "changed", 0)
        graph.observe("B", A2, "C", "score increased", 0)
        self.assertIn(("B", A2), graph.known_score_edges())
        self.assertNotIn(("A", A1), graph.known_score_edges())

        graph.observe("A", A1, "B", "changed", 0)
        self.assertEqual(graph.neighbors("A")[A1].visits, 2)

    def test_conflicting_observations_make_edge_non_executable(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "score increased", 0)
        graph.observe("A", A1, "C", "changed", 0)

        self.assertFalse(graph.neighbors("A")[A1].stable)
        self.assertNotIn(("A", A1), graph.known_score_edges())
        self.assertIsNone(graph.path_to_score("A", 3, never_blocked))

    def test_path_to_score_returns_action_sequence(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "changed", 0)
        graph.observe("B", A2, "C", "score increased", 0)
        path = graph.path_to_score("A", max_depth=5, is_blocked=never_blocked)
        self.assertEqual(path, [A1, A2])

    def test_path_to_score_immediate_edge(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", CLICK, "B", "score increased", 1)
        path = graph.path_to_score("A", max_depth=5, is_blocked=never_blocked)
        self.assertEqual(path, [CLICK])

    def test_path_to_score_respects_blocked(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "score increased", 0)
        blocked = graph.path_to_score("A", max_depth=5, is_blocked=lambda ak: ak == A1)
        self.assertIsNone(blocked)

    def test_path_to_frontier_skips_blocked_and_routes_onward(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "changed", 0)  # A has tried A1
        candidates = {"A": [A1, A2], "B": [A3]}
        path = graph.path_to_frontier(
            "A",
            candidate_provider=lambda key: candidates.get(key, []),
            max_depth=5,
            # A2 (the only untried action at A) is blocked -> must route to B's frontier
            is_blocked=lambda ak: ak == A2,
        )
        self.assertEqual(path, [A1, A3])

    def test_path_to_frontier_returns_immediate_untried(self) -> None:
        graph = TransitionGraph()
        graph.observe("A", A1, "B", "changed", 0)
        candidates = {"A": [A1, A2]}
        path = graph.path_to_frontier(
            "A",
            candidate_provider=lambda key: candidates.get(key, []),
            max_depth=5,
            is_blocked=never_blocked,
        )
        self.assertEqual(path, [A2])

    def test_sparse_graph_returns_none(self) -> None:
        graph = TransitionGraph()
        self.assertIsNone(graph.path_to_score("X", max_depth=5, is_blocked=never_blocked))
        self.assertIsNone(
            graph.path_to_frontier(
                "X",
                candidate_provider=lambda key: [],
                max_depth=5,
                is_blocked=never_blocked,
            )
        )


if __name__ == "__main__":
    unittest.main()
