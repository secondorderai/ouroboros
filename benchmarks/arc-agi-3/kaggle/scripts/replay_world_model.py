from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.world_model import ExecutableWorldModel, TransitionRecord  # noqa: E402


def load_records(path: Path) -> list[TransitionRecord]:
    records: list[TransitionRecord] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
            raw = event["controller"]["world_model"]["last_record"]
            records.append(TransitionRecord.from_json(raw))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid world-model trace line {line_number}: {exc}") from exc
    return records


def replay_summary(records: list[TransitionRecord]) -> dict[str, Any]:
    model = ExecutableWorldModel()
    model.replay(records)
    canonical = json.dumps(
        [record.to_json() for record in records],
        sort_keys=True,
        separators=(",", ":"),
    )
    final = records[-1] if records else None
    hypotheses = []
    if final is not None:
        key = final.to_key or final.from_key
        observed_actions = {
            record.action_key
            for record in records
            if record.level == final.level and record.action_key[0] != 0
        }
        hypotheses = [
            {
                "id": hypothesis.id,
                "action_key": list(hypothesis.action_key),
                "prediction": list(hypothesis.predicted_effects),
                "information_gain": hypothesis.information_gain,
                "risk": hypothesis.risk,
                "cpu_prior": hypothesis.deterministic_score,
            }
            for hypothesis in model.hypotheses(
                final.level,
                key,
                observed_actions,
                is_blocked=lambda _action: False,
            )
        ]
    ambiguous_edges = sum(
        1
        for adjacency in model.graph.edges.values()
        for edge in adjacency.values()
        if not edge.stable
    )
    return {
        "record_digest": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "observations": model.observation_count,
        "novel_observations": model.novel_observation_count,
        "states": len(model.graph.edges),
        "score_edges": len(model.graph.known_score_edges()),
        "ambiguous_edges": ambiguous_edges,
        "prediction": model.prediction_metrics(),
        "mechanic_templates": [
            {
                "id": template.id,
                "action_schema": template.action_schema,
                "outcome": template.predicted_outcome,
                "effect": template.predicted_effect,
                "support": template.support,
                "contradictions": template.contradictions,
                "confidence": template.confidence,
            }
            for template in model.mechanic_templates()
        ],
        "hypotheses": hypotheses,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Replay deterministic ARC world-model induction from JSONL telemetry."
    )
    parser.add_argument("trace", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    summary = replay_summary(load_records(args.trace))
    body = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding="utf-8")
    print(body, end="")


if __name__ == "__main__":
    main()
