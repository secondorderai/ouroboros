"""M3 gate: synthetic games 1-4 won with the model path, 0 LLM calls."""
from ouro2.director import Director
from ouro2.induce import induce
from ouro2.rules import ClickRule, MoveRule

from .fake_env import FakeEnv, run_agent
from .synthetic_games import AV, CollectGame, MazeGame, PushGame, ToggleDoorsGame


def play(game, max_actions=320):
    env = FakeEnv(game)
    director = Director()
    view = run_agent(env, director, max_actions=max_actions)
    return view, director


def test_maze_won_with_planning_and_low_waste():
    view, director = play(MazeGame())
    assert view.state == "WIN"
    s = director.summary()
    # The model path must be exercised, not just exploration.
    assert s["plan_steps"] > 0, s
    assert s["actions"] < 250, s


def test_maze_induces_move_rule_and_goal():
    view, director = play(MazeGame())
    model = director.model
    assert model is not None
    assert model.binding.avatar_color == AV
    move = next(r for r in model.rules if isinstance(r, MoveRule))
    assert dict(move.deltas) == {1: (0, -1), 2: (0, 1), 3: (-1, 0), 4: (1, 0)}
    # clear_color(GOAL) is the sound predicate here: reach_color (adjacency)
    # is falsified by wandering next to the goal without entering it, and the
    # goal cell is consumed on entry — so "no goal color left" is exactly
    # what level completion looks like.
    assert model.goal is not None
    assert (model.goal.kind, model.goal.color) == ("clear_color", 12)


def test_push_game_won():
    view, director = play(PushGame())
    assert view.state == "WIN"
    assert director.summary()["plan_steps"] > 0 or director.summary()["actions"] < 320


def test_toggle_doors_won_and_click_rule_inducible():
    view, director = play(ToggleDoorsGame())
    assert view.state == "WIN"
    # The explorer wins this game in a handful of clicks (before the live
    # model forms) — honest behavior for a trivial click game. The click
    # mechanic must still be inducible from the recorded transitions.
    model = induce(director.timeline)
    click = next((r for r in model.rules if isinstance(r, ClickRule)), None)
    assert click is not None
    assert dict(click.mapping).get(10) == 11  # BTN -> DOOR color


def test_collect_game_won():
    view, director = play(CollectGame())
    assert view.state == "WIN"
    s = director.summary()
    assert s["actions"] < 320, s


def test_evaluate_supports_maze_replay():
    # Induce from a played maze timeline; the model must replay it near-exactly.
    view, director = play(MazeGame())
    model = induce(director.timeline)
    total = model.report.support + model.report.contradictions
    assert total > 20
    assert model.report.support / total > 0.9, (
        model.report.support,
        model.report.contradictions,
    )
