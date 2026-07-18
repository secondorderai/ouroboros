from __future__ import annotations

import threading
import unittest

from ouro_arc.autonomous_model import AutonomousModelWorker
from ouro_arc.shared_mechanics import (
    DiscoveryBarrier,
    HelperProposal,
    HelperTestCase,
    SharedMechanicsRegistry,
    StableBatchCoordinator,
)


def proposal(name: str = "identity", source_game: str = "source") -> HelperProposal:
    tests = (
        HelperTestCase("color", (3,), 3),
        HelperTestCase("coordinate", ([2, 4],), [2, 4]),
        HelperTestCase("shape", ([[1, 2], [3, 4]],), [[1, 2], [3, 4]]),
        HelperTestCase("size", ([1, 2],), [1, 2]),
        HelperTestCase("count", ([1, 2],), [1, 2]),
    )
    return HelperProposal(
        name=name,
        source=f"def {name}(value):\n    return value\n",
        tests=tests,
        source_game=source_game,
        replay_passed=True,
        critic_approved=True,
    )


class SharedMechanicsRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = SharedMechanicsRegistry(AutonomousModelWorker(timeout_seconds=2))

    def tearDown(self) -> None:
        self.registry.close()

    def test_promotes_verified_generic_helper_and_deduplicates(self) -> None:
        first = self.registry.promote(proposal())
        second = self.registry.promote(proposal())
        self.assertTrue(first.accepted)
        self.assertEqual(second.reason, "duplicate")
        self.assertEqual(self.registry.version, 1)

    def test_rejects_missing_transformation_and_game_identifier(self) -> None:
        candidate = proposal()
        candidate = HelperProposal(
            candidate.name,
            candidate.source,
            candidate.tests[:1],
            candidate.source_game,
            True,
            True,
        )
        self.assertIn("missing transformed", self.registry.promote(candidate).reason)
        leaked = proposal(source_game="ft09")
        leaked = HelperProposal(
            leaked.name,
            leaked.source + '\nGAME="ft09"',
            leaked.tests,
            leaked.source_game,
            True,
            True,
        )
        self.assertIn("game-specific", self.registry.promote(leaked).reason)

    def test_name_conflict_uses_canonical_hash(self) -> None:
        left = proposal()
        right = HelperProposal(
            left.name,
            "def identity(value):\n    return value[:] if isinstance(value, list) else value\n",
            left.tests,
            left.source_game,
            True,
            True,
        )
        results = self.registry.merge([right, left])
        self.assertEqual(sum(result.accepted for result in results), 1)
        self.assertEqual(len(self.registry.snapshot()[1]), 1)


class DiscoveryCoordinationTest(unittest.TestCase):
    def test_barrier_merges_only_after_every_participant(self) -> None:
        registry = SharedMechanicsRegistry(AutonomousModelWorker(timeout_seconds=2))
        barrier = DiscoveryBarrier(2, registry, timeout_seconds=2)
        releases = []
        first = threading.Thread(target=lambda: releases.append(barrier.arrive("b", [proposal("helper_b")])) )
        first.start()
        releases.append(barrier.arrive("a", [proposal("helper_a")]))
        first.join()
        try:
            self.assertEqual(registry.version, 2)
            self.assertEqual({release.participants for release in releases}, {("a", "b")})
        finally:
            registry.close()

    def test_stable_batch_executes_in_participant_order(self) -> None:
        coordinator: StableBatchCoordinator[str] = StableBatchCoordinator(3, 2)
        results: dict[str, str | None] = {}
        threads = [
            threading.Thread(
                target=lambda name=name: results.setdefault(
                    name,
                    coordinator.submit(name, lambda name=name: name.upper()),
                )
            )
            for name in ("c", "a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(coordinator.execution_order, ["a", "b", "c"])
        self.assertEqual(results, {"a": "A", "b": "B", "c": "C"})

    def test_barrier_timeout_keeps_base_library_version(self) -> None:
        registry = SharedMechanicsRegistry(AutonomousModelWorker(timeout_seconds=2))
        barrier = DiscoveryBarrier(2, registry, timeout_seconds=0.01)
        try:
            release = barrier.arrive("only", [proposal()])
            self.assertTrue(release.timed_out)
            self.assertEqual(release.library_version, 0)
            self.assertEqual(registry.version, 0)
        finally:
            registry.close()


if __name__ == "__main__":
    unittest.main()
