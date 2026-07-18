from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "logs/kaggle-qwen-validation/qwen_gpu_validation.json")
    report = json.loads(path.read_text(encoding="utf-8"))
    print(f"stage={report.get('stage')} smoke_passed={report.get('smoke_passed')}")
    selection = report.get("selection", {})
    print(f"selected_mode={selection.get('selected_mode')}")
    for mode, summary in selection.get("summaries", {}).items():
        print(
            f"pilot {mode}: levels={summary['levels']} score={summary['score']:.6f} "
            f"parse={summary['parse_rate']:.3f} median={summary['median_latency']:.2f}s "
            f"p95={summary['p95_latency']:.2f}s projected={summary['projected_model_seconds']:.1f}s"
        )
    full = report.get("full")
    if full:
        print(
            f"full score={float(full.get('score', 0)):.12f} "
            f"games={len(full.get('games', []))} runtime={float(full.get('runtime_seconds', 0)):.1f}s"
        )
    promotion = report.get("promotion")
    if promotion:
        print(f"promote={promotion['promote']} delta={promotion['score_delta']:.12f}")
        for reason in promotion.get("reasons", []):
            print(f"  - {reason}")


if __name__ == "__main__":
    main()
