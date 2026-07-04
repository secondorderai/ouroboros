"""Single source of truth for the holdout split (DEV/TEST/QUARANTINE).

The public leaderboard reruns on hidden games, so local play on the 25 public
games is only an honest LB proxy if some games are held out of all tuning. This
module is the sanctioned home for the game-id literals that define that split;
every script imports from here so the folds never drift.

Keep this module pure (no I/O). It is deliberately excluded from the overfit
linter precisely because it is the one place game ids are allowed to live.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

# Tunable fold: DEV results may drive code/param changes.
DEV_GAMES = frozenset(
    {
        "ft09",
        "m0r0",
        "sp80",
        "s5i5",
        "ls20",
        "lp85",
        "cn04",
        "tr87",
        "sb26",
        "sk48",
        "bp35",
        "r11l",
        "tu93",
    }
)

# LB proxy: TEST results may only be read to report the proxy, never to tune.
TEST_GAMES = frozenset(
    {
        "vc33",
        "lf52",
        "su15",
        "sc25",
        "g50t",
        "wa30",
        "ka59",
        "dc22",
        "tn36",
    }
)

# Reserved for a declared final calibration; untouched until then.
QUARANTINE_GAMES = frozenset({"ar25", "re86", "cd82"})

ALL_PUBLIC_GAMES = DEV_GAMES | TEST_GAMES | QUARANTINE_GAMES


def normalize_game_id(game_id: str) -> str:
    """Reduce an id like ``"vc33-ab12cd34"`` or ``"VC33"`` to the bare ``"vc33"``."""
    return game_id.split("-")[0].strip().lower()


def fold_of(game_id: str) -> Optional[str]:
    """Return the fold name for ``game_id`` or ``None`` if it is unknown."""
    normalized = normalize_game_id(game_id)
    if normalized in DEV_GAMES:
        return "dev"
    if normalized in TEST_GAMES:
        return "test"
    if normalized in QUARANTINE_GAMES:
        return "quarantine"
    return None


def achieved_levels(row: dict[str, Any]) -> int:
    """Highest level reached, tolerating a level regression at the final frame."""
    return max(
        int(row.get("levels_completed", 0)),
        int(row.get("max_level_reached", 0)),
    )


def fold_rows(rows: Iterable[dict[str, Any]], fold: str) -> list[dict[str, Any]]:
    """Filter ``rows`` down to the entries whose game id belongs to ``fold``."""
    return [row for row in rows if fold_of(str(row.get("game_id", ""))) == fold]


def fold_levels(rows: Iterable[dict[str, Any]], fold: str) -> int:
    """Sum ``achieved_levels`` over the rows in ``fold``."""
    return sum(achieved_levels(row) for row in fold_rows(rows, fold))
