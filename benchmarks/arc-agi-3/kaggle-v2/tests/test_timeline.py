from ouro2.grid import from_rows
from ouro2.timeline import RESET, ActionSpec, Timeline


G0 = from_rows([[0]])
G1 = from_rows([[1]])


def step(tl, action, state="NOT_FINISHED", lb=0, la=0, full_reset=False, after=G1):
    return tl.append(G0, action, after, state, lb, la, full_reset)


def test_level_attribution_and_level_up():
    tl = Timeline()
    t1 = step(tl, ActionSpec(1))
    t2 = step(tl, ActionSpec(2), lb=0, la=1)
    t3 = step(tl, ActionSpec(3), lb=1, la=1)
    assert (t1.level, t2.level, t3.level) == (0, 0, 1)
    assert not t1.level_up and t2.level_up and not t3.level_up
    levels = tl.levels()
    assert [(s.level, len(s.transitions)) for s in levels] == [(0, 2), (1, 1)]
    assert levels[0].completed and not levels[1].completed


def test_plays_split_on_full_reset():
    tl = Timeline()
    step(tl, ActionSpec(1))
    step(tl, ActionSpec(2), state="WIN", lb=0, la=1)
    step(tl, RESET, full_reset=True, lb=0, la=0)
    step(tl, ActionSpec(1))
    plays = tl.plays()
    assert [len(p) for p in plays] == [2, 2]
    assert plays[1][0].full_reset


def test_burned_transition_has_no_after():
    tl = Timeline()
    t = tl.append(G0, ActionSpec(4), None, "GAME_OVER", 0, 0)
    assert t.burned


def test_current_level_transitions_follow_latest_play_and_level():
    tl = Timeline()
    step(tl, ActionSpec(1), lb=0, la=1)
    step(tl, ActionSpec(2), lb=1, la=1)
    step(tl, ActionSpec(3), lb=1, la=1)
    current = tl.current_level_transitions()
    assert [t.action.action for t in current] == [2, 3]


def test_winning_macro_per_level_from_winning_play():
    tl = Timeline()
    # Play 1: no win.
    step(tl, ActionSpec(5))
    step(tl, RESET, state="GAME_OVER", after=G0)
    # A win within the same play (level resets don't split plays).
    step(tl, ActionSpec(1), lb=0, la=0)
    step(tl, ActionSpec(2), lb=0, la=1)
    step(tl, ActionSpec(3), lb=1, la=2, state="WIN")
    macro = tl.winning_macro()
    assert macro is not None
    assert [[a.action for a in level] for level in macro] == [[5, 0, 1, 2], [3]]
    tl2 = Timeline()
    step(tl2, ActionSpec(1))
    assert tl2.winning_macro() is None
