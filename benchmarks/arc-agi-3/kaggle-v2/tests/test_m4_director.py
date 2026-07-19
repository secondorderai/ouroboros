"""M4 gate: hazard/noop games, post-WIN speedrun, concurrent CPU budget."""
import threading
import time

from ouro2.director import Director

from .fake_env import FakeEnv, run_agent
from .synthetic_games import HazardTickGame, MazeGame, NoopGame


def test_hazard_game_won_with_bounded_deaths():
    env = FakeEnv(HazardTickGame())
    director = Director()
    view = run_agent(env, director, max_actions=320)
    assert view.state == "WIN"
    s = director.summary()
    # Deaths are allowed while learning, but the autopsy ban must keep them
    # bounded — never the same death twice from the same state.
    assert s["resets"] <= 12, s


def test_noop_game_futility_ledger():
    env = FakeEnv(NoopGame())
    director = Director()
    view = run_agent(env, director, max_actions=320)
    assert view.state == "WIN"
    s = director.summary()
    # Each of the three no-op actions costs at most one probe per state;
    # revisits must not re-pay them.
    assert s["noops"] < 90, s
    assert s["actions"] < 300, s


def test_post_win_speedrun_replays_compressed_and_rescores():
    env = FakeEnv(MazeGame())
    director = Director()
    view = run_agent(env, director, max_actions=320)
    assert view.state == "WIN"
    s = director.summary()
    assert s["speedrun_actions"] > 0, s
    assert env.plays >= 2  # the replay ran in a fresh scored play
    assert view.levels_completed == 2  # and completed the game again
    # The whole point: the replay is much shorter than the learning play.
    assert s["speedrun_actions"] < 40, s


def test_concurrent_games_stay_within_cpu_budget():
    games = [MazeGame(), NoopGame(), MazeGame(), NoopGame()]
    results = {}

    def play(i, game):
        env = FakeEnv(game)
        d = Director()
        results[i] = (run_agent(env, d, max_actions=320), d)

    started = time.monotonic()
    threads = [
        threading.Thread(target=play, args=(i, g), daemon=True)
        for i, g in enumerate(games)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    elapsed = time.monotonic() - started
    assert elapsed < 45, elapsed
    for i, (view, d) in results.items():
        assert view.state == "WIN", (i, d.summary())
