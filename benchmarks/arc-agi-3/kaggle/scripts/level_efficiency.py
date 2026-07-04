"""Diagnostic: dump per-level baseline vs actions-taken efficiency for a game.

Reveals the quadratic-score headroom: per-level score = (baseline/actions)^2 * 100.
Not part of the submission; local analysis only.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", required=True)
    parser.add_argument("--max-steps", type=int, default=320)
    args = parser.parse_args()

    vendor = ROOT / "vendor" / "ARC-AGI-3-Agents"
    sys.path.insert(0, str(vendor))
    os.environ.setdefault("OURO_ARC_DISABLE_MODEL", "1")
    os.environ["OURO_ARC_GAME_ID"] = args.game

    import arc_agi  # type: ignore
    from arc_agi import OperationMode  # type: ignore

    spec = importlib.util.spec_from_file_location("agent_mod", ROOT / "agent" / "my_agent.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore
    MyAgent = mod.MyAgent
    MyAgent.MAX_ACTIONS = args.max_steps

    arc = arc_agi.Arcade(operation_mode=OperationMode.NORMAL)
    envs = arc.get_environments()
    full = next(e.game_id for e in envs if e.game_id.split("-")[0] == args.game)
    env = arc.make(full)
    agent = MyAgent(
        card_id="diag", game_id=full, agent_name="diag", ROOT_URL="http://localhost",
        record=False, arc_env=env, tags=["diag"],
    )
    agent.main()

    sc = arc.get_scorecard()
    for envscore in sc.environments:
        for run in envscore.runs:
            ba = run.level_baseline_actions or []
            la = run.level_actions or []
            ls = run.level_scores or []
            print(f"game={args.game} levels_completed={run.levels_completed} total_actions={run.actions} score={run.score:.3f}")
            for i in range(len(ls)):
                b = ba[i] if i < len(ba) else "?"
                a = la[i] if i < len(la) else "?"
                ratio = (f"{b/a:.2f}x" if isinstance(b, int) and isinstance(a, int) and a and b > 0 else "n/a")
                print(f"  level {i}: baseline={b} actions={a} ratio(base/act)={ratio} level_score={ls[i]:.2f}")


if __name__ == "__main__":
    main()
