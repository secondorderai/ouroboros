from ouro2.director import Director

from .fake_env import FakeEnv, run_agent
from .synthetic_games import MazeGame


def test_maze_won_by_exploration_alone():
    env = FakeEnv(MazeGame())
    director = Director()
    view = run_agent(env, director, max_actions=320)
    assert view.state == "WIN"
    summary = director.summary()
    assert summary["levels_completed"] == 2
    assert summary["actions"] <= 320
    # Wall bumps get banned per state — waste must stay bounded.
    assert summary["noops"] < 80, summary


def test_director_never_raises_on_burned_frames():
    env = FakeEnv(MazeGame())
    director = Director()
    view = env.initial_view()
    action = director.choose(view)  # NOT_PLAYED -> RESET
    assert action.is_reset()
    view = env.step(action)
    # Feed a burned (empty) frame directly; director must cope.
    burned = env._view(grid_rows=[], full_reset=False)
    spec = director.choose(burned)
    assert spec is not None
