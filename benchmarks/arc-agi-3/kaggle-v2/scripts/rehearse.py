"""Rehearse the EXACT Kaggle topology locally.

Kaggle reruns play through an HTTP gateway: the framework's main.py in
ONLINE mode against http://gateway:8001. This script reproduces that
precisely — arc_agi's listen_and_serve on localhost:8001 in one process,
the vendored framework's main.py (agents swarm) in another — so transport
behavior (guid churn, frame stacks over HTTP, cookies) is validated before
any kernel push. V1 never tested this path locally.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRAMEWORK = ROOT / "vendor" / "ARC-AGI-3-Agents"
STAGE = ROOT / ".rehearse"
PORT = 8001


def start_server(games: list[str]) -> subprocess.Popen:
    code = f"""
import sys
sys.path.insert(0, {str(ROOT)!r})
import arc_agi
from arc_agi import OperationMode
arc = arc_agi.Arcade(
    operation_mode=OperationMode.OFFLINE,
    environments_dir={str(ROOT / 'environment_files')!r},
)
arc.listen_and_serve(host="127.0.0.1", port={PORT})
"""
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


def wait_for_gateway(timeout_s: float = 30.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/games", timeout=2)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def stage_framework() -> Path:
    """Copy the framework and install our agent, exactly as the notebook
    does on Kaggle (fresh copy per rehearsal)."""
    if STAGE.exists():
        shutil.rmtree(STAGE)
    dst = STAGE / "ARC-AGI-3-Agents"
    shutil.copytree(
        FRAMEWORK, dst,
        ignore=shutil.ignore_patterns(".git", "__pycache__", ".venv"),
    )
    shutil.copy(ROOT / "agent" / "my_agent.py", dst / "agents" / "templates" / "my_agent.py")
    shutil.copytree(ROOT / "ouro2", dst / "ouro2")
    (dst / "agents" / "__init__.py").write_text(
        "from .agent import Agent\n"
        "from .swarm import Swarm\n"
        "from .templates.my_agent import MyAgent\n"
        "AVAILABLE_AGENTS = {'myagent': MyAgent}\n"
    )
    (dst / ".env").write_text(
        f"SCHEME=http\nHOST=127.0.0.1\nPORT={PORT}\n"
        "ARC_API_KEY=test-key-123\nOPERATION_MODE=online\n"
    )
    return dst


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--game",
        default=None,
        help="game id (defaults to the first available environment)",
    )
    parser.add_argument("--max-actions", type=int, default=120)
    args = parser.parse_args()

    server = start_server([])
    try:
        if not wait_for_gateway():
            raise SystemExit("gateway did not come up on :8001")
        print(f"gateway up on :{PORT}")
        dst = stage_framework()
        env = dict(os.environ)
        env["OURO2_MAX_ACTIONS"] = str(args.max_actions)
        env["OURO2_DISABLE_MODEL"] = env.get("OURO2_DISABLE_MODEL", "1")
        # Swarm builds Arcade() bare, which resolves ARC_BASE_URL env ->
        # production default. Point it at the local gateway.
        env["ARC_BASE_URL"] = f"http://127.0.0.1:{PORT}"
        env["ARC_API_KEY"] = "test-key-123"
        if args.game is None:
            envs = sorted(p.name for p in (ROOT / "environment_files").iterdir() if p.is_dir())
            args.game = envs[0]
        game_arg = args.game.split(",")[0]
        result = subprocess.run(
            [sys.executable, "main.py", "--agent", "myagent", "--game", game_arg],
            cwd=dst,
            env=env,
            capture_output=True,
            text=True,
            timeout=900,
        )
        out = result.stdout + result.stderr
        tail = "\n".join(out.splitlines()[-15:])
        print(tail)
        # Honest criterion: the agent must have actually played (its summary
        # line proves it) and nothing may have crashed.
        ok = "[ouro2]" in out and "Traceback" not in out
        print(f"\nrehearsal {'PASSED' if ok else 'FAILED'} (exit {result.returncode})")
        if not ok:
            raise SystemExit(1)
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    main()
