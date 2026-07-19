from ouro2 import grid
from ouro2.rules import (
    Binding,
    ClickRule,
    Goal,
    HazardRule,
    MoveRule,
    State,
    TickRule,
    avatar_cells,
    is_goal,
    step,
)

AV = 3  # avatar color
WALL = 4
PELLET = 5
BOX = 6
HZ = 7

DELTAS = ((1, (0, -1)), (2, (0, 1)), (3, (-1, 0)), (4, (1, 0)))
BINDING = Binding(avatar_color=AV, background=0)


def make(cells):
    rows = [[0] * grid.SIZE for _ in range(grid.SIZE)]
    for x, y, c in cells:
        rows[y][x] = c
    return grid.from_rows(rows)


def test_move_and_blocker():
    g = make([(5, 5, AV), (5, 4, WALL)])
    st = State(g)
    rule = MoveRule(deltas=DELTAS, blockers=frozenset({WALL}))
    up, out = step(st, (1, None, None), (rule,), BINDING)
    assert out == "blocked" and up.grid == g
    right, out = step(st, (4, None, None), (rule,), BINDING)
    assert out == "moved"
    assert grid.cell(right.grid, 6, 5) == AV and grid.cell(right.grid, 5, 5) == 0
    assert grid.cell(right.grid, 5, 4) == WALL


def test_move_consumes_and_counts():
    g = make([(5, 5, AV), (6, 5, PELLET)])
    st = State(g)
    rule = MoveRule(deltas=DELTAS, consumes=frozenset({PELLET}))
    nxt, out = step(st, (4, None, None), (rule,), BINDING)
    assert out == "moved"
    assert nxt.counter(PELLET) == 1
    assert PELLET not in nxt.grid


def test_push_chain_and_blocked_push():
    g = make([(5, 5, AV), (6, 5, BOX), (7, 5, BOX)])
    rule = MoveRule(deltas=DELTAS, blockers=frozenset({WALL}), pushable=frozenset({BOX}))
    nxt, out = step(State(g), (4, None, None), (rule,), BINDING)
    assert out == "moved"
    assert grid.cell(nxt.grid, 6, 5) == AV
    assert grid.cell(nxt.grid, 7, 5) == BOX and grid.cell(nxt.grid, 8, 5) == BOX
    g2 = make([(5, 5, AV), (6, 5, BOX), (7, 5, WALL)])
    nxt2, out2 = step(State(g2), (4, None, None), (rule,), BINDING)
    assert out2 == "blocked" and nxt2.grid == g2


def test_on_block_die_and_slide():
    g = make([(5, 5, AV), (5, 4, WALL)])
    die_rule = MoveRule(deltas=DELTAS, blockers=frozenset({WALL}), on_block="die")
    dead, out = step(State(g), (1, None, None), (die_rule,), BINDING)
    assert out == "died" and dead.status == "GAME_OVER"
    g2 = make([(1, 5, AV), (6, 5, WALL)])
    slide_rule = MoveRule(deltas=DELTAS, blockers=frozenset({WALL}), slide=True)
    slid, out2 = step(State(g2), (4, None, None), (slide_rule,), BINDING)
    assert out2 == "moved"
    assert grid.cell(slid.grid, 5, 5) == AV  # slid until the wall


def test_click_scopes():
    g = make([(2, 2, 9), (3, 2, 9), (10, 10, 9)])
    cell_rule = ClickRule(scope="cell", mapping=((9, 1),))
    st, out = step(State(g), (6, 2, 2), (cell_rule,), BINDING)
    assert out == "clicked"
    assert grid.cell(st.grid, 2, 2) == 1 and grid.cell(st.grid, 3, 2) == 9
    obj_rule = ClickRule(scope="object", mapping=((9, 1),))
    st2, _ = step(State(g), (6, 2, 2), (obj_rule,), BINDING)
    assert grid.cell(st2.grid, 3, 2) == 1 and grid.cell(st2.grid, 10, 10) == 9
    color_rule = ClickRule(scope="color", mapping=((9, 1),))
    st3, _ = step(State(g), (6, 2, 2), (color_rule,), BINDING)
    assert grid.cell(st3.grid, 10, 10) == 1


def test_tick_move_translates_objects():
    g = make([(5, 5, AV), (10, 10, HZ)])
    tick = TickRule(color=HZ, delta=(1, 0))
    rule = MoveRule(deltas=DELTAS)
    nxt, _ = step(State(g), (2, None, None), (rule, tick), BINDING)
    assert grid.cell(nxt.grid, 11, 10) == HZ and grid.cell(nxt.grid, 10, 10) == 0


def test_hazard_adjacency_kills():
    g = make([(5, 5, AV), (7, 5, HZ)])
    rule = MoveRule(deltas=DELTAS)
    hazard = HazardRule(colors=frozenset({HZ}))
    nxt, out = step(State(g), (4, None, None), (rule, hazard), BINDING)
    assert out == "died" and nxt.status == "GAME_OVER"


def test_goals():
    g = make([(5, 5, AV), (6, 5, 12)])
    st = State(g)
    assert is_goal(st, Goal("reach_color", 12), BINDING)
    assert not is_goal(st, Goal("clear_color", 12), BINDING)
    assert is_goal(st, Goal("clear_color", 13), BINDING)
    assert not is_goal(st, Goal("counter_eq", PELLET, 2), BINDING)
    st2 = st.with_counter(PELLET, 2)
    assert is_goal(st2, Goal("counter_eq", PELLET, 2), BINDING)


def test_avatar_cells_largest_component():
    g = make([(5, 5, AV), (5, 6, AV), (20, 20, AV)])
    cells = avatar_cells(g, BINDING)
    assert cells == frozenset({(5, 5), (5, 6)})
