from __future__ import annotations

from dataclasses import dataclass, field

from .actions import ActionSpec


DEFAULT_BURST_WINDOWS = (8, 24, 64)
EXPLORE_ACTIONS = (1, 2, 3, 4, 5, 7)


@dataclass
class ExplorePolicy:
    """Generic repeated-action exploration for deterministic local runs."""

    burst_windows: tuple[int, ...] = DEFAULT_BURST_WINDOWS
    attempts: dict[tuple[int, str, int], int] = field(default_factory=dict)
    banned: set[tuple[int, str, int]] = field(default_factory=set)

    def reset_level(self, level: int | None = None) -> None:
        if level is None:
            self.attempts = {}
            self.banned = set()
            return
        self.attempts = {key: value for key, value in self.attempts.items() if key[0] != level}
        self.banned = {key for key in self.banned if key[0] != level}

    def ban(self, level: int, frame_key: str, action: int) -> None:
        self.banned.add((level, frame_key, action))
        self.banned.add((level, "*", action))

    def plan(
        self,
        *,
        level: int,
        frame_key: str,
        available_actions: set[int],
        probed_actions: set[int],
        dangerous: set[tuple[int, str, tuple[int, int | None, int | None]]],
        noop: set[tuple[int, str, tuple[int, int | None, int | None]]],
        demoted_sources: set[str],
    ) -> list[ActionSpec]:
        if "explore-repeat" in demoted_sources:
            return []
        simple_available = {action for action in EXPLORE_ACTIONS if action in available_actions}
        if not simple_available or not simple_available <= probed_actions:
            return []

        for action in sorted(simple_available):
            key = (level, "*", action)
            if key in self.banned or (level, frame_key, action) in self.banned:
                continue
            spec = ActionSpec(action, reason="repeated-action exploration", source="explore-repeat")
            edge = (level, frame_key, spec.key)
            if edge in dangerous or edge in noop:
                continue
            attempt = self.attempts.get(key, 0)
            if attempt >= len(self.burst_windows):
                continue
            self.attempts[key] = attempt + 1
            return [spec for _ in range(self.burst_windows[attempt])]
        return []
