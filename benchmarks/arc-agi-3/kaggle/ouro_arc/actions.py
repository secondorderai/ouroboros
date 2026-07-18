from __future__ import annotations

from dataclasses import dataclass
from typing import Any


RESET_ACTION = 0
SIMPLE_ACTIONS = {1, 2, 3, 4, 5}
COMPLEX_ACTIONS = {6, 7}
VALID_ACTIONS = {RESET_ACTION, *SIMPLE_ACTIONS, *COMPLEX_ACTIONS}


@dataclass(frozen=True)
class ActionSpec:
    """Framework-independent action plan item.

    `action=0` means RESET. `action=6` is the coordinate click used by ARC-AGI-3.
    The framework adapter in `agent/my_agent.py` converts this to `GameAction`.
    """

    action: int
    x: int | None = None
    y: int | None = None
    reason: str = ""
    source: str = "controller"

    @property
    def key(self) -> tuple[int, int | None, int | None]:
        return (self.action, self.x, self.y)

    def is_reset(self) -> bool:
        return self.action == RESET_ACTION

    def is_complex(self) -> bool:
        return self.action in COMPLEX_ACTIONS

    def validate(self, available_actions: set[int] | None = None) -> None:
        if self.action not in VALID_ACTIONS:
            raise ValueError(f"invalid ARC action {self.action}")
        if self.action == RESET_ACTION:
            return
        if available_actions is not None and self.action not in available_actions:
            raise ValueError(
                f"action {self.action} is not available; valid={sorted(available_actions)}"
            )
        if self.action == 6:
            if self.x is None or self.y is None:
                raise ValueError("ACTION6 requires x and y")
            if not (0 <= self.x <= 63 and 0 <= self.y <= 63):
                raise ValueError(f"ACTION6 coordinates out of bounds: ({self.x},{self.y})")

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "action": self.action,
            "reason": self.reason,
            "source": self.source,
        }
        if self.x is not None:
            out["x"] = self.x
        if self.y is not None:
            out["y"] = self.y
        return out

    def to_model_json(self) -> dict[str, int]:
        """Return only the environmental action fields visible to a world model."""

        out = {"action": self.action}
        if self.x is not None:
            out["x"] = self.x
        if self.y is not None:
            out["y"] = self.y
        return out

    @classmethod
    def from_json(cls, value: Any) -> "ActionSpec":
        if isinstance(value, str):
            name = value.upper().strip()
            if name == "RESET":
                return cls(RESET_ACTION, source="model")
            if name.startswith("ACTION"):
                return cls(int(name.removeprefix("ACTION")), source="model")
            raise ValueError(f"unknown action string: {value}")

        if not isinstance(value, dict):
            raise ValueError(f"action must be object or string, got {type(value).__name__}")

        raw_action = value.get("action", value.get("name"))
        if isinstance(raw_action, str):
            raw_action = raw_action.upper().replace("ACTION", "").replace("RESET", "0")
        action = int(raw_action)
        x = value.get("x")
        y = value.get("y")
        return cls(
            action=action,
            x=int(x) if x is not None else None,
            y=int(y) if y is not None else None,
            reason=str(value.get("reason", value.get("why", ""))),
            source=str(value.get("source", "model")),
        )


def normalize_available_actions(raw: Any) -> set[int]:
    """Accept ints, enum values, or enum-like objects from `arcengine`."""

    result: set[int] = set()
    if raw is None:
        return result
    for item in raw:
        if isinstance(item, int):
            result.add(item)
            continue
        value = getattr(item, "value", item)
        if isinstance(value, int):
            result.add(value)
            continue
        name = str(getattr(item, "name", item)).upper()
        if name.startswith("ACTION"):
            try:
                result.add(int(name.removeprefix("ACTION")))
            except ValueError:
                pass
    return result


def filter_legal_actions(
    actions: list[ActionSpec],
    available_actions: set[int],
) -> list[ActionSpec]:
    legal: list[ActionSpec] = []
    for action in actions:
        try:
            action.validate(available_actions)
        except ValueError:
            continue
        legal.append(action)
    return legal
