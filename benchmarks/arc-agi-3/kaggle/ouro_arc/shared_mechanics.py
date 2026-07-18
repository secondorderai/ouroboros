"""Verified process-wide helper promotion and deterministic discovery barrier."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Generic, Iterable, TypeVar

from .autonomous_model import AutonomousModelWorker, validate_generated_source

REQUIRED_TEST_KINDS = frozenset({"color", "coordinate", "shape", "size", "count"})
GAME_ID_PATTERN = re.compile(r"\b[a-z][a-z0-9]?\d{2}\b", re.I)


@dataclass(frozen=True)
class HelperTestCase:
    kind: str
    args: tuple[Any, ...]
    expected: Any
    kwargs: dict[str, Any] | None = None


@dataclass(frozen=True)
class HelperProposal:
    name: str
    source: str
    tests: tuple[HelperTestCase, ...]
    source_game: str
    replay_passed: bool
    critic_approved: bool

    @property
    def source_hash(self) -> str:
        return hashlib.sha256(self.source.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PromotedHelper:
    name: str
    source: str
    source_hash: str
    source_game: str
    test_kinds: tuple[str, ...]


@dataclass(frozen=True)
class HelperPromotionResult:
    accepted: bool
    reason: str
    helper: PromotedHelper | None = None


class SharedMechanicsRegistry:
    """Immutable snapshots with atomic, deterministic helper promotion."""

    def __init__(self, worker: AutonomousModelWorker | None = None) -> None:
        self._lock = threading.RLock()
        self._helpers: dict[str, PromotedHelper] = {}
        self._hashes: set[str] = set()
        self._version = 0
        self._worker = worker or AutonomousModelWorker()
        self.rejections: dict[str, int] = {}

    @property
    def version(self) -> int:
        with self._lock:
            return self._version

    def snapshot(self) -> tuple[int, tuple[PromotedHelper, ...]]:
        with self._lock:
            return self._version, tuple(self._helpers[name] for name in sorted(self._helpers))

    def source_bundle(self) -> str:
        _version, helpers = self.snapshot()
        return "\n\n".join(helper.source for helper in helpers)

    def prompt_summary(self, max_chars: int = 12000) -> str:
        version, helpers = self.snapshot()
        text = f"Shared helper library version={version}\n" + "\n\n".join(
            f"# helper {helper.name} sha={helper.source_hash[:12]}\n{helper.source}"
            for helper in helpers
        )
        return text[:max_chars]

    def promote(self, proposal: HelperProposal) -> HelperPromotionResult:
        validation = validate_generated_source(proposal.source, helper=True)
        if not validation.valid:
            return self._reject(validation.reason)
        if not proposal.replay_passed:
            return self._reject("source replay not passed")
        if not proposal.critic_approved:
            return self._reject("critic did not approve")
        if proposal.name not in validation.function_names:
            return self._reject("declared helper function missing")
        if GAME_ID_PATTERN.search(proposal.source) or proposal.source_game.lower() in proposal.source.lower():
            return self._reject("game-specific identifier in helper source")
        kinds = frozenset(test.kind for test in proposal.tests)
        missing = REQUIRED_TEST_KINDS - kinds
        if missing:
            return self._reject(f"missing transformed tests: {', '.join(sorted(missing))}")
        for test in proposal.tests:
            try:
                base = self._worker.request(
                    {
                        "operation": "invoke",
                        "source": proposal.source,
                        "function": proposal.name,
                        "args": list(test.args),
                        "kwargs": test.kwargs or {},
                    }
                )
                transformed_args = [
                    _metamorphic_transform(test.kind, item)
                    for item in test.args
                ]
                transformed_kwargs = {
                    key: _metamorphic_transform(test.kind, item)
                    for key, item in (test.kwargs or {}).items()
                }
                if transformed_args == list(test.args) and transformed_kwargs == (test.kwargs or {}):
                    return self._reject(f"helper fixture not transformable ({test.kind})")
                expected = _metamorphic_transform(test.kind, base.get("value"))
                raw = self._worker.request(
                    {
                        "operation": "invoke",
                        "source": proposal.source,
                        "function": proposal.name,
                        "args": transformed_args,
                        "kwargs": transformed_kwargs,
                    }
                )
            except Exception as exc:
                return self._reject(f"helper test error ({test.kind}): {exc!r}")
            if raw.get("value") != expected:
                return self._reject(f"helper metamorphic test failed ({test.kind})")
        promoted = PromotedHelper(
            name=proposal.name,
            source=proposal.source,
            source_hash=proposal.source_hash,
            source_game=proposal.source_game,
            test_kinds=tuple(sorted(kinds)),
        )
        with self._lock:
            if promoted.source_hash in self._hashes:
                existing = next(item for item in self._helpers.values() if item.source_hash == promoted.source_hash)
                return HelperPromotionResult(True, "duplicate", existing)
            current = self._helpers.get(proposal.name)
            if current is not None:
                if current.source_hash < promoted.source_hash:
                    return self._reject("name conflict lost canonical hash tie-break")
                self._hashes.discard(current.source_hash)
            self._helpers[proposal.name] = promoted
            self._hashes.add(promoted.source_hash)
            self._version += 1
        return HelperPromotionResult(True, "promoted", promoted)

    def merge(self, proposals: Iterable[HelperProposal]) -> tuple[HelperPromotionResult, ...]:
        ordered = sorted(proposals, key=lambda item: (item.name, item.source_hash))
        return tuple(self.promote(proposal) for proposal in ordered)

    def summary(self) -> dict[str, Any]:
        version, helpers = self.snapshot()
        return {
            "version": version,
            "helpers": [
                {"name": helper.name, "hash": helper.source_hash, "source_game": helper.source_game}
                for helper in helpers
            ],
            "rejections": dict(sorted(self.rejections.items())),
        }

    def close(self) -> None:
        self._worker.close()

    def _reject(self, reason: str) -> HelperPromotionResult:
        with self._lock:
            self.rejections[reason] = self.rejections.get(reason, 0) + 1
        return HelperPromotionResult(False, reason)


def _metamorphic_transform(kind: str, value: Any) -> Any:
    """Apply host-owned equivariance transforms to helper inputs and outputs."""

    if kind == "color":
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and 0 <= value <= 15:
            return (value + 1) % 16
        if isinstance(value, list):
            return [_metamorphic_transform(kind, item) for item in value]
        if isinstance(value, tuple):
            return tuple(_metamorphic_transform(kind, item) for item in value)
        if isinstance(value, dict):
            return {key: _metamorphic_transform(kind, item) for key, item in value.items()}
        return value
    if kind == "coordinate":
        if (
            isinstance(value, (list, tuple))
            and len(value) == 2
            and all(isinstance(item, int) and not isinstance(item, bool) for item in value)
        ):
            moved = [int(value[0]) + 2, int(value[1]) + 3]
            return tuple(moved) if isinstance(value, tuple) else moved
        if isinstance(value, list):
            return [_metamorphic_transform(kind, item) for item in value]
        if isinstance(value, tuple):
            return tuple(_metamorphic_transform(kind, item) for item in value)
        if isinstance(value, dict):
            return {key: _metamorphic_transform(kind, item) for key, item in value.items()}
        return value
    if kind == "shape":
        if (
            isinstance(value, list)
            and value
            and all(isinstance(row, list) for row in value)
        ):
            return [list(reversed(row)) for row in value]
        if isinstance(value, list):
            return [_metamorphic_transform(kind, item) for item in value]
        if isinstance(value, tuple):
            return tuple(_metamorphic_transform(kind, item) for item in value)
        if isinstance(value, dict):
            return {key: _metamorphic_transform(kind, item) for key, item in value.items()}
        return value
    if kind == "size":
        if isinstance(value, list) and value:
            return [*value, value[-1]]
        if isinstance(value, tuple) and value:
            return (*value, value[-1])
        if isinstance(value, int) and not isinstance(value, bool):
            return value + 1
        if isinstance(value, dict):
            return {key: _metamorphic_transform(kind, item) for key, item in value.items()}
        return value
    if kind == "count":
        if isinstance(value, list) and value:
            return [value[0], *value]
        if isinstance(value, tuple) and value:
            return (value[0], *value)
        if isinstance(value, int) and not isinstance(value, bool):
            return value + 1
        if isinstance(value, dict):
            return {key: _metamorphic_transform(kind, item) for key, item in value.items()}
        return value
    raise ValueError(f"unknown helper transform kind: {kind}")


@dataclass(frozen=True)
class DiscoveryRelease:
    generation: int
    timed_out: bool
    participants: tuple[str, ...]
    library_version: int


class DiscoveryBarrier:
    """Collect one discovery wave and publish one order-independent snapshot."""

    def __init__(
        self,
        expected_participants: int,
        registry: SharedMechanicsRegistry,
        timeout_seconds: float | None = None,
    ) -> None:
        self.expected_participants = max(1, expected_participants)
        self.registry = registry
        self.timeout_seconds = float(
            timeout_seconds
            or os.getenv("OURO_ARC_DISCOVERY_BARRIER_SECONDS", "720")
        )
        self._condition = threading.Condition()
        self._submissions: dict[str, tuple[HelperProposal, ...]] = {}
        self._release: DiscoveryRelease | None = None
        self._base_version = registry.version

    def arrive(
        self,
        game_id: str,
        proposals: Iterable[HelperProposal] = (),
    ) -> DiscoveryRelease:
        deadline = time.monotonic() + self.timeout_seconds
        with self._condition:
            if self._release is not None:
                return self._release
            self._submissions.setdefault(game_id, tuple(proposals))
            if len(self._submissions) >= self.expected_participants:
                merged = [
                    proposal
                    for name in sorted(self._submissions)
                    for proposal in self._submissions[name]
                ]
                self.registry.merge(merged)
                self._release = DiscoveryRelease(
                    generation=1,
                    timed_out=False,
                    participants=tuple(sorted(self._submissions)),
                    library_version=self.registry.version,
                )
                self._condition.notify_all()
                return self._release
            while self._release is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._release = DiscoveryRelease(
                        generation=1,
                        timed_out=True,
                        participants=tuple(sorted(self._submissions)),
                        library_version=self._base_version,
                    )
                    self._condition.notify_all()
                    break
                self._condition.wait(remaining)
            return self._release


T = TypeVar("T")


class StableBatchCoordinator(Generic[T]):
    """Run one callable per participant in stable ID order after all arrive."""

    def __init__(self, expected_participants: int, timeout_seconds: float) -> None:
        self.expected_participants = max(1, expected_participants)
        self.timeout_seconds = max(0.01, timeout_seconds)
        self._condition = threading.Condition()
        self._tasks: dict[str, Callable[[], T]] = {}
        self._results: dict[str, T] = {}
        self._processing = False
        self._released = False
        self.timed_out = False
        self.execution_order: list[str] = []

    def submit(self, participant: str, task: Callable[[], T]) -> T | None:
        deadline = time.monotonic() + self.timeout_seconds
        leader = False
        with self._condition:
            if self._released:
                return self._results.get(participant)
            self._tasks.setdefault(participant, task)
            if len(self._tasks) >= self.expected_participants and not self._processing:
                self._processing = True
                leader = True
            while not leader and not self._released:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.timed_out = True
                    self._released = True
                    self._condition.notify_all()
                    return None
                self._condition.wait(remaining)
            if not leader:
                return self._results.get(participant)

        for name in sorted(self._tasks):
            if time.monotonic() >= deadline:
                self.timed_out = True
                break
            try:
                self._results[name] = self._tasks[name]()
                self.execution_order.append(name)
            except Exception:
                continue
        with self._condition:
            self._released = True
            self._condition.notify_all()
            return self._results.get(participant)


_SESSION_LOCK = threading.RLock()
_SESSION_REGISTRY: SharedMechanicsRegistry | None = None
_SESSION_BARRIER: DiscoveryBarrier | None = None
_SESSION_BATCH: StableBatchCoordinator[Any] | None = None


def session_registry() -> SharedMechanicsRegistry:
    global _SESSION_REGISTRY
    with _SESSION_LOCK:
        if _SESSION_REGISTRY is None:
            _SESSION_REGISTRY = SharedMechanicsRegistry()
        return _SESSION_REGISTRY


def session_barrier() -> DiscoveryBarrier:
    global _SESSION_BARRIER
    with _SESSION_LOCK:
        if _SESSION_BARRIER is None:
            expected = max(1, int(os.getenv("OURO_ARC_DISCOVERY_PARTICIPANTS", "25")))
            _SESSION_BARRIER = DiscoveryBarrier(expected, session_registry())
        return _SESSION_BARRIER


def session_discovery_batch() -> StableBatchCoordinator[Any]:
    global _SESSION_BATCH
    with _SESSION_LOCK:
        if _SESSION_BATCH is None:
            expected = max(1, int(os.getenv("OURO_ARC_DISCOVERY_PARTICIPANTS", "25")))
            timeout = float(os.getenv("OURO_ARC_DISCOVERY_BARRIER_SECONDS", "720"))
            _SESSION_BATCH = StableBatchCoordinator(expected, timeout)
        return _SESSION_BATCH


def reset_session_state_for_tests() -> None:
    global _SESSION_REGISTRY, _SESSION_BARRIER, _SESSION_BATCH
    with _SESSION_LOCK:
        if _SESSION_REGISTRY is not None:
            _SESSION_REGISTRY.close()
        _SESSION_REGISTRY = None
        _SESSION_BARRIER = None
        _SESSION_BATCH = None
