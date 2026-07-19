"""Append-only interaction record.

The timeline is the ground truth every rule hypothesis is tested against
(Schema's "record" stage). Hypotheses are revisable; the observations and
actions here are not. Segmentation into plays (full resets) and levels is
derived, never stored twice.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .grid import Grid


@dataclass(frozen=True)
class ActionSpec:
    action: int  # 0=RESET, 1-5, 6=click, 7
    x: int | None = None
    y: int | None = None
    source: str = ""
    reason: str = ""

    def is_reset(self) -> bool:
        return self.action == 0

    def key(self) -> tuple[int, int | None, int | None]:
        return (self.action, self.x, self.y)


RESET = ActionSpec(0, source="reset")


@dataclass(frozen=True)
class Transition:
    index: int
    level: int  # level the action was taken in (levels_completed before)
    before: Grid | None
    action: ActionSpec
    after: Grid | None  # None for burned actions (empty frame stack)
    state_after: str  # NOT_FINISHED | WIN | GAME_OVER | NOT_PLAYED
    levels_before: int
    levels_after: int
    full_reset: bool

    @property
    def level_up(self) -> bool:
        return self.levels_after > self.levels_before

    @property
    def burned(self) -> bool:
        return self.after is None


@dataclass
class LevelSegment:
    play: int
    level: int
    transitions: list[Transition] = field(default_factory=list)

    @property
    def completed(self) -> bool:
        return bool(self.transitions) and self.transitions[-1].level_up


class Timeline:
    def __init__(self) -> None:
        self.transitions: list[Transition] = []

    def __len__(self) -> int:
        return len(self.transitions)

    def append(
        self,
        before: Grid | None,
        action: ActionSpec,
        after: Grid | None,
        state_after: str,
        levels_before: int,
        levels_after: int,
        full_reset: bool = False,
    ) -> Transition:
        t = Transition(
            index=len(self.transitions),
            level=levels_before,
            before=before,
            action=action,
            after=after,
            state_after=state_after,
            levels_before=levels_before,
            levels_after=levels_after,
            full_reset=full_reset,
        )
        self.transitions.append(t)
        return t

    def plays(self) -> list[list[Transition]]:
        """Split on full resets; the reset transition starts the new play."""
        out: list[list[Transition]] = [[]]
        for t in self.transitions:
            if t.full_reset and out[-1]:
                out.append([])
            out[-1].append(t)
        return out if out[0] else out[1:]

    def levels(self) -> list[LevelSegment]:
        segments: list[LevelSegment] = []
        for play_idx, play in enumerate(self.plays()):
            current: LevelSegment | None = None
            for t in play:
                if current is None or t.level != current.level:
                    current = LevelSegment(play=play_idx, level=t.level)
                    segments.append(current)
                current.transitions.append(t)
        return segments

    def current_level_transitions(self) -> list[Transition]:
        if not self.transitions:
            return []
        level = self.transitions[-1].levels_after
        plays = self.plays()
        return [t for t in plays[-1] if t.level == level]

    def winning_macro(self) -> list[list[ActionSpec]] | None:
        """Per-level action sequences from the play that reached WIN.

        Includes every action taken while on that level (RESETs and all) —
        the speedrun replays this verbatim; compression is the planner's job.
        """
        for play in self.plays():
            if not any(t.state_after == "WIN" for t in play):
                continue
            per_level: dict[int, list[ActionSpec]] = {}
            for t in play:
                per_level.setdefault(t.level, []).append(t.action)
            return [per_level[level] for level in sorted(per_level)]
        return None
