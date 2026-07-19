"""The submit gate certifies a CACHED fold run; these pin the freshness
binding that refuses to certify a run of different agent source."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import holdout_gate  # noqa: E402


def test_staleness_detects_missing_and_mismatched_hash():
    assert holdout_gate.staleness({}) is not None
    assert holdout_gate.staleness({"source_hash": "0000deadbeef0000"}) is not None
    assert holdout_gate.staleness({"source_hash": holdout_gate.source_hash()}) is None


def test_source_hash_covers_agent_source():
    # Stable across calls, sensitive to any ouro2/agent source byte.
    a = holdout_gate.source_hash()
    assert a == holdout_gate.source_hash()
    assert len(a) == 16
