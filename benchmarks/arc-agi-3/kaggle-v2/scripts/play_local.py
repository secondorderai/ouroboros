"""Local runner: plays public games through the vendored framework agent
against the offline arc engine, scoring with the official scorecard."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "vendor" / "ARC-AGI-3-Agents"))

from ouro2.holdout import FOLDS, normalize_game_id  # noqa: E402

SLIM_REGISTRY = (
    '"""Slim agent registry (mirrors the submission notebook, which rewrites\n'
    'this file on Kaggle — the stock one imports every template and their\n'
    'heavyweight dependencies)."""\n'
    "from .agent import Agent\n\n"
    "AVAILABLE_AGENTS: dict = {}\n"
)


def ensure_slim_registry() -> None:
    init = ROOT / "vendor" / "ARC-AGI-3-Agents" / "agents" / "__init__.py"
    if init.exists() and "Slim agent registry" not in init.read_text():
        init.write_text(SLIM_REGISTRY)


def load_my_agent_class():
    ensure_slim_registry()
    spec = importlib.util.spec_from_file_location(
        "ouro2_kaggle_agent", ROOT / "agent" / "my_agent.py"
    )
    if spec is None or spec.loader is None:
        raise SystemExit("Could not load agent/my_agent.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MyAgent


def play_game(arc, MyAgent, game_id: str) -> dict:
    env = arc.make(game_id)
    if env is None:
        return {"game_id": game_id, "error": "could not create env"}
    agent = MyAgent(
        card_id="local-dev",
        game_id=game_id,
        agent_name=f"ouro2.local.{game_id}",
        ROOT_URL="http://localhost",
        record=False,
        arc_env=env,
        tags=["local-dev", "ouro2"],
    )
    agent.main()
    final = agent.frames[-1] if agent.frames else None
    row = {
        "game_id": game_id,
        "state": str(getattr(final, "state", "?")),
        "levels_completed": int(getattr(final, "levels_completed", 0)),
        "actions": int(agent.action_counter),
    }
    row.update({"director": agent.director.summary()})
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", default=None, help="game id(s), comma-separated")
    parser.add_argument("--fold", default=None, choices=[None, "dev", "test", "quarantine"])
    parser.add_argument("--max-steps", type=int, default=320)
    parser.add_argument("--results-json", default=None)
    parser.add_argument("--list", action="store_true")
    parser.add_argument(
        "--concurrent",
        action="store_true",
        help="Thread-per-game (rehearses the Kaggle swarm's GIL contention)",
    )
    args = parser.parse_args()

    import arc_agi
    from arc_agi import OperationMode

    # OFFLINE against local environment_files: hermetic, and the same mode
    # the Kaggle-side validation uses.
    arc = arc_agi.Arcade(
        operation_mode=OperationMode.OFFLINE,
        environments_dir=str(ROOT / "environment_files"),
    )
    all_ids = [env.game_id.split("-")[0] for env in arc.get_environments()]
    if args.list:
        print("\n".join(sorted(all_ids)))
        return

    if args.game:
        wanted = {normalize_game_id(g) for g in args.game.split(",")}
    elif args.fold:
        wanted = set(FOLDS[args.fold])
    else:
        wanted = set(all_ids)
    game_ids = sorted(g for g in all_ids if g in wanted)
    missing = wanted - set(game_ids)
    if missing:
        raise SystemExit(f"Unknown game ids: {sorted(missing)}")

    MyAgent = load_my_agent_class()
    MyAgent.MAX_ACTIONS = min(MyAgent.MAX_ACTIONS, args.max_steps)

    rows: dict[str, dict] = {}
    if args.concurrent:
        threads = []
        for game_id in game_ids:
            t = threading.Thread(
                target=lambda g=game_id: rows.__setitem__(g, play_game(arc, MyAgent, g)),
                daemon=True,
            )
            threads.append(t)
            t.start()
        for t in threads:
            t.join()
    else:
        for i, game_id in enumerate(game_ids, 1):
            print(f"=== [{i}/{len(game_ids)}] {game_id} ===", flush=True)
            rows[game_id] = play_game(arc, MyAgent, game_id)
            r = rows[game_id]
            print(
                f"  -> {r.get('state')} levels={r.get('levels_completed')} "
                f"actions={r.get('actions')}",
                flush=True,
            )

    scorecard = arc.get_scorecard()
    score = float(getattr(scorecard, "score", 0.0))
    print("\n========= SUMMARY =========")
    for game_id in game_ids:
        r = rows.get(game_id, {})
        print(
            f"{game_id:8} levels={r.get('levels_completed', 0):3} "
            f"actions={r.get('actions', 0):5} state={r.get('state', '?')}"
        )
    print(f"\nAggregate scorecard score: {score}")

    if args.results_json:
        path = Path(args.results_json)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "score": score,
            "max_steps": args.max_steps,
            "levels": {g: rows[g].get("levels_completed", 0) for g in rows},
            "games": [rows[g] for g in game_ids if g in rows],
        }
        path.write_text(json.dumps(payload, indent=2, sort_keys=True))
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
