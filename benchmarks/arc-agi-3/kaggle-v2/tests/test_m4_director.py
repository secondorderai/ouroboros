"""M4 gate: hazard/noop games, post-WIN speedrun, concurrent CPU budget."""
import threading
import time

from ouro2.director import Director

from .fake_env import FakeEnv, run_agent
from .synthetic_games import HazardTickGame, MazeGame, NoopGame


def test_hazard_game_bounded_deaths_and_coverage():
    """A single-level game with an unknown goal and a patrolling hazard is
    the honest "level-0 lab cost" case: finishing blind within budget is
    luck, so this asserts the MECHANISMS — the autopsy bounds deaths and
    never repeats an identical one, and the walk keeps covering ground
    despite the enemy's animation churn."""
    env = FakeEnv(HazardTickGame())
    director = Director()
    view = run_agent(env, director, max_actions=320)
    deaths = [
        t
        for t in director.timeline.transitions
        if t.state_after == "GAME_OVER" and t.before is not None
    ]
    assert len(deaths) <= 8, len(deaths)
    pairs = [(director._key(t.before), t.action.key()) for t in deaths]
    assert len(pairs) == len(set(pairs)), "identical death repeated"
    from ouro2.grid import components

    positions = set()
    for t in director.timeline.transitions:
        if t.after is not None:
            objs = components(t.after, colors={3}, background=0)
            if objs:
                positions.add(objs[0].centroid)
    assert len(positions) >= 12, len(positions)


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
