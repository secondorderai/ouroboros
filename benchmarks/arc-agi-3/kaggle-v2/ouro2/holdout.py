"""Holdout split (DEV/TEST/QUARANTINE) — fold literals identical to V1's.

The public leaderboard reruns on hidden games, so local play on the 25
public games is only an honest LB proxy if some games are held out of all
tuning. This module is the ONE sanctioned home for game-id literals; the
overfit lint enforces that no other module contains them.
"""
from __future__ import annotations

from dataclasses import dataclass

DEV_GAMES = frozenset(
    {
        "ft09", "m0r0", "sp80", "s5i5", "ls20", "lp85", "cn04",
        "tr87", "sb26", "sk48", "bp35", "r11l", "tu93",
    }
)

# LB proxy: read to report, never to tune.
TEST_GAMES = frozenset(
    {"vc33", "lf52", "su15", "sc25", "g50t", "wa30", "ka59", "dc22", "tn36"}
)

# Untouched until a declared final calibration before submission.
QUARANTINE_GAMES = frozenset({"ar25", "re86", "cd82"})

ALL_PUBLIC_GAMES = DEV_GAMES | TEST_GAMES | QUARANTINE_GAMES

FOLDS = {"dev": DEV_GAMES, "test": TEST_GAMES, "quarantine": QUARANTINE_GAMES}


def normalize_game_id(game_id: str) -> str:
    return game_id.split("-")[0].strip().lower()


@dataclass(frozen=True)
class GateResult:
    ok: bool
    reasons: tuple[str, ...]


def gate(test_results: dict, baseline: dict, eps: float = 0.005) -> GateResult:
    """Block when the TEST fold regresses vs the ratcheted baseline.

    ``test_results``/``baseline``: {"score": float, "levels": {game: int}}.
    """
    reasons = []
    base_levels = baseline.get("levels", {})
    got_levels = test_results.get("levels", {})
    for game, base in base_levels.items():
        if got_levels.get(game, 0) < base:
            reasons.append(
                f"TEST regression: {game} levels {got_levels.get(game, 0)} < {base}"
            )
    if test_results.get("score", 0.0) < baseline.get("score", 0.0) - eps:
        reasons.append(
            f"TEST score {test_results.get('score', 0.0):.4f} < "
            f"baseline {baseline.get('score', 0.0):.4f} - {eps}"
        )
    return GateResult(ok=not reasons, reasons=tuple(reasons))
