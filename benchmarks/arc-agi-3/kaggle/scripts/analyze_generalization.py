from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ouro_arc.generalization import compare_runs, summarize_generalization  # noqa: E402


def load(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def markdown(report: dict[str, Any]) -> str:
    candidate = report["candidate"]
    lines = [
        "# ARC Generalization Report",
        "",
        f"- Score delta: `{report['score_delta']:+.9f}`",
        f"- Level delta: `{report['level_delta']:+d}`",
        f"- Action delta: `{report['action_delta']:+d}`",
        f"- Generalization gate: `{'PASS' if report['generalization_gate'] else 'FAIL'}`",
        f"- Regressions: `{', '.join(report['regressions']) or 'none'}`",
        f"- Improvements: `{', '.join(report['improvements']) or 'none'}`",
        "",
        "| Fold | Levels | Delta | Actions | Delta |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, summary in candidate["folds"].items():
        delta = report["fold_deltas"][name]
        lines.append(
            f"| {name} | {summary['levels']} | {delta['levels']:+d} | "
            f"{summary['actions']} | {delta['actions']:+d} |"
        )
    overall = candidate["overall"]
    lines.extend(
        [
            "",
            f"World-model effect prediction accuracy: `{overall['effect_prediction_accuracy']:.3f}` "
            f"over `{overall['prediction_attempts']}` predictions.",
            f"Novel observation rate: `{overall['novel_observation_rate']:.3f}`.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--markdown-output", type=Path)
    args = parser.parse_args()

    report = compare_runs(load(args.candidate), load(args.baseline))
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    body = markdown(report)
    if args.markdown_output:
        args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_output.write_text(body, encoding="utf-8")
    print(body, end="")


if __name__ == "__main__":
    main()
