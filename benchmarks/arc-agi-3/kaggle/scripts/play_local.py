from __future__ import annotations

import argparse
import importlib.util
import logging
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_my_agent_class():
    spec = importlib.util.spec_from_file_location(
        "ouroboros_kaggle_agent",
        ROOT / "agent" / "my_agent.py",
    )
    if spec is None or spec.loader is None:
        raise SystemExit("Could not load agent/my_agent.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MyAgent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", default=None, help="Game id or comma-separated ids")
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--render", default=None, choices=[None, "terminal"])
    parser.add_argument(
        "--model",
        action="store_true",
        help="Allow Gemma loading locally; by default local runs disable the model.",
    )
    args = parser.parse_args()

    vendor = ROOT / "vendor" / "ARC-AGI-3-Agents"
    if not vendor.exists():
        raise SystemExit(f"Framework not found at {vendor}. Run `make setup` first.")
    sys.path.insert(0, str(vendor))

    import arc_agi  # type: ignore
    from arc_agi import OperationMode  # type: ignore

    if not args.model:
        os.environ.setdefault("OURO_ARC_DISABLE_MODEL", "1")
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    arc = arc_agi.Arcade(operation_mode=OperationMode.NORMAL)
    all_envs = arc.get_environments()
    if args.list:
        for env in all_envs:
            print(f"{env.game_id}: {getattr(env, 'title', '?')}")
        return

    if args.game:
        wanted = {g.strip().split("-")[0] for g in args.game.split(",")}
        game_ids = [
            env.game_id.split("-")[0]
            for env in all_envs
            if env.game_id.split("-")[0] in wanted
        ]
        missing = wanted - set(game_ids)
        if missing:
            raise SystemExit(f"Unknown game ids: {sorted(missing)}")
    else:
        game_ids = [env.game_id.split("-")[0] for env in all_envs]

    MyAgent = load_my_agent_class()
    MyAgent.MAX_ACTIONS = min(getattr(MyAgent, "MAX_ACTIONS", args.max_steps), args.max_steps)

    rows = []
    for index, game_id in enumerate(game_ids, 1):
        print(f"=== [{index}/{len(game_ids)}] {game_id} ===")
        env = arc.make(game_id, render_mode=args.render)
        if env is None:
            print(f"  could not create env for {game_id}")
            continue
        agent = MyAgent(
            card_id="local-dev",
            game_id=game_id,
            agent_name=f"MyAgent.local.{game_id}",
            ROOT_URL="http://localhost",
            record=False,
            arc_env=env,
            tags=["local-dev", "ouroboros", "gemma4"],
        )
        agent.main()
        final = agent.frames[-1]
        rows.append((game_id, final.state, final.levels_completed, agent.action_counter))
        print(
            f"  -> state={final.state}, levels_completed={final.levels_completed}, "
            f"actions={agent.action_counter}"
        )

    print("\n========= SUMMARY =========")
    for game_id, state, levels, actions in rows:
        print(f"{game_id:8} levels={levels:3} actions={actions:5} state={state}")
    scorecard = arc.get_scorecard()
    print(f"\nAggregate scorecard score: {getattr(scorecard, 'score', scorecard)}")


if __name__ == "__main__":
    main()
