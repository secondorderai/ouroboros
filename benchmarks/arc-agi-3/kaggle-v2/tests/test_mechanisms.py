"""Unit coverage for the evidence mechanisms the synthetic games never
exercise (no synthetic game has a HUD, a depleting bar, a pattern board,
or an oscillating toggle that survives to the milk path). Each test here
would fail if its mechanism were reverted."""
from ouro2.explore import Explorer
from ouro2.induce import depleting_colors, masked_eq, rebind, volatile_cells
from ouro2.rules import Binding
from ouro2.timeline import ActionSpec, Timeline

W = 64
EMPTY = bytes(4096)


def put(g: bytes, cells: dict[tuple[int, int], int]) -> bytes:
    flat = bytearray(g)
    for (x, y), color in cells.items():
        flat[y * W + x] = color
    return bytes(flat)


def append_step(tl: Timeline, before: bytes, action: ActionSpec, after: bytes) -> None:
    tl.append(before, action, after, "NOT_FINISHED", 0, 0)


# -- far-click cell volatility ---------------------------------------------


def test_far_click_cells_are_volatile_near_cells_are_not():
    tl = Timeline()
    click = ActionSpec(6, 5, 5)
    base = EMPTY
    for i in range(14):
        cells = {}
        if i in (3, 7):  # HUD counter at (60, 60): far from every click
            cells[(60, 60)] = 9
        if i in (4, 8):  # gameplay change adjacent to the click
            cells[(6, 5)] = 5
        after = put(base, cells)
        append_step(tl, base, click, after)
        base = EMPTY  # changes revert so each transition diffs afresh
    vol = volatile_cells(tl)
    assert 60 * W + 60 in vol  # 2 far-click changes suffice
    assert 5 * W + 6 not in vol  # near-click churn stays visible


# -- reset-aware depleting colors ------------------------------------------


def test_depleting_color_survives_reset_refill_grow_only_exempt():
    tl = Timeline()
    move = ActionSpec(1)

    def bar(length: int, paint: int) -> bytes:
        cells = {(x, 0): 11 for x in range(length)}  # draining energy bar
        cells.update({(x, 63): 4 for x in range(paint)})  # growing paint
        return put(EMPTY, cells)

    prev = bar(10, 0)
    for i in range(6):  # six strict decreases of color 11, six grows of 4
        cur = bar(9 - i, i + 1)
        append_step(tl, prev, move, cur)
        prev = cur
    # Level reset refills the bar: without the chain break this +6 jump
    # would register as an increase and disqualify color 11.
    refilled = bar(10, 6)
    tl.append(prev, ActionSpec(0), refilled, "NOT_FINISHED", 0, 0)
    prev = refilled
    for i in range(5):
        cur = bar(9 - i, 6)
        append_step(tl, prev, move, cur)
        prev = cur
    dep = depleting_colors(tl)
    assert 11 in dep
    assert 4 not in dep  # grow-only colors are gameplay, not masked here


# -- union-masked equality --------------------------------------------------


def test_masked_eq_unions_depleting_positions_and_protects_avatar():
    stale = put(EMPTY, {(2, 2): 11})  # prediction still shows the bar cell
    real = put(EMPTY, {(2, 2): 3})  # reality: drained, floor revealed
    assert not masked_eq(stale, real, frozenset(), frozenset())
    assert masked_eq(stale, real, frozenset(), frozenset({11}))
    # The avatar's color is never masked away, even if it depletes.
    a = put(EMPTY, {(4, 4): 12})
    b = put(EMPTY, {(4, 4): 3})
    assert not masked_eq(a, b, frozenset(), frozenset({12}), keep=12)


# -- novelty-guarded click milking ------------------------------------------


def test_click_milking_stops_when_changes_revisit_states():
    g = put(EMPTY, {(x, y): 5 for x in range(8, 10) for y in range(8, 10)})
    ex = Explorer()
    ex.note_result("s0", ActionSpec(6, 3, 3), changed=True, grid=g, novel=True)
    assert ex.next(g, [6]).reason == "milk click"
    # Changed but revisiting = oscillating toggle: milking must disarm.
    ex.note_result("s1", ActionSpec(6, 3, 3), changed=True, grid=g, novel=False)
    assert ex.last_click_streak == 0
    assert ex.next(g, [6]).reason != "milk click"


# -- sticky bindings ---------------------------------------------------------


def test_rebind_keeps_prior_binding_when_evidence_evaporates():
    tl = Timeline()  # no move evidence at all in the window
    prior = Binding(avatar_color=7, avatar_extra=frozenset({9}))
    assert rebind(tl, prior=prior) is prior
    assert rebind(tl, prior=None).avatar_color is None


# -- cell-precision click targets -------------------------------------------


def test_click_targets_enumerate_pattern_board_cells():
    board = {(x, y): 2 for x in range(10, 16) for y in range(20, 26)}  # 6x6
    g = put(EMPTY, {**board, (50, 50): 5})
    ex = Explorer()
    targets = ex._click_targets(g)
    # Centroids come first; the mid-sized board then contributes every cell.
    assert (10, 20) in targets and (15, 25) in targets
    assert sum(1 for t in targets if t in board) >= 36


# -- review findings: director mask/key regressions -------------------------


def test_avatar_color_zero_survives_mask_update():
    from ouro2.director import Director

    # Avatar of color 0 on a color-3 background: `avatar or prior` dropped
    # the binding because 0 is falsy.
    def g(x: int) -> bytes:
        flat = bytearray([3]) * 4096
        flat[10 * W + x] = 0
        return bytes(flat)

    d = Director()
    for i in range(6):
        d.timeline.append(g(10 + i), ActionSpec(4), g(11 + i), "NOT_FINISHED", 0, 0)
    d._maybe_reinduce()
    assert d.model is not None and d.model.binding.avatar_color == 0
    assert d.mask_avatar == 0


def test_rebuild_keys_records_masked_noops_as_bans():
    from ouro2.director import Director

    # A transition that only ticked a masked HUD cell must rebuild as a
    # no-op (ban), exactly as _record would have judged it live.
    d = Director()
    hud = (60, 60)
    d.mask_volatile = frozenset({hud[1] * W + hud[0]})
    before = EMPTY
    after = put(EMPTY, {hud: 9})
    d.timeline.append(before, ActionSpec(1), after, "NOT_FINISHED", 0, 0)
    d._rebuild_keys()
    assert (d._key(before), (1, None, None)) in d.explorer.noop_bans
