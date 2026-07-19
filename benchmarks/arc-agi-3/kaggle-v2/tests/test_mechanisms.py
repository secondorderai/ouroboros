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


def test_far_click_needs_distinct_origins_switch_door_stays_visible():
    # A HUD counter changes for far clicks at MANY coordinates -> masked.
    # A door toggled by its one remote switch changes under a single far
    # origin -> must stay visible (remote-effect gameplay, not HUD).
    tl = Timeline()
    for i in range(14):
        cells = {}
        if i in (3, 7):  # counter reacts to far clicks from two origins
            cells[(60, 60)] = 9
        if i in (4, 8):  # door reacts only to its one switch at (5, 5)
            cells[(50, 50)] = 7
        click = ActionSpec(6, 5, 5) if i != 7 else ActionSpec(6, 20, 20)
        append_step(tl, EMPTY, click, put(EMPTY, cells))
    vol = volatile_cells(tl)
    assert 60 * W + 60 in vol  # two distinct far origins -> HUD
    assert 50 * W + 50 not in vol  # single-switch door stays gameplay


def test_churn_masking_requires_action_independence():
    # A cell churning on nearly every transition is masked only when >=2
    # distinct actions drove the churn (action-independence = HUD); the
    # same churn under a single repeated action stays visible.
    def build(actions):
        tl = Timeline()
        for i, a in enumerate(actions):
            before = put(EMPTY, {(30, 30): 5 if i % 2 else 6})
            after = put(EMPTY, {(30, 30): 6 if i % 2 else 5})
            append_step(tl, before, ActionSpec(a), after)
        return tl
    both = volatile_cells(build([1, 2] * 10))
    single = volatile_cells(build([1] * 20))
    assert 30 * W + 30 in both
    assert 30 * W + 30 not in single


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


def test_click_targets_enumerate_cells_once_color_shows_click_evidence():
    # 10x10 board (size 100 — outside the old 9-49 window): once a click
    # on its color has produced a change, its cells are enumerated.
    board = {(x, y): 2 for x in range(10, 20) for y in range(20, 30)}
    g = put(EMPTY, {**board, (50, 50): 5})
    ex = Explorer()
    # No evidence yet: centroids only, no cell sweep.
    assert sum(1 for t in ex._click_targets(g) if t in board) <= 1
    ex.note_result("s0", ActionSpec(6, 12, 22), changed=True, grid=g)
    targets = ex._click_targets(g)
    assert (10, 20) in targets and (19, 29) in targets
    assert sum(1 for t in targets if t in board) >= 100


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


def test_bans_key_off_raw_change_masks_only_rank():
    from ouro2.director import Director

    # A truly changeless transition rebuilds as a ban; a transition whose
    # only change sits under a mask does NOT — a wrong mask must never be
    # able to permanently bury an action (the remote-switch scenario).
    d = Director()
    hud = (60, 60)
    d.mask_volatile = frozenset({hud[1] * W + hud[0]})
    noop_after = EMPTY
    masked_after = put(EMPTY, {hud: 9})
    d.timeline.append(EMPTY, ActionSpec(1), noop_after, "NOT_FINISHED", 0, 0)
    d.timeline.append(EMPTY, ActionSpec(2), masked_after, "NOT_FINISHED", 0, 0)
    d._rebuild_keys()
    key = d._key(EMPTY)
    assert (key, (1, None, None)) in d.explorer.noop_bans
    assert (key, (2, None, None)) not in d.explorer.noop_bans


# -- generalization pass: death-model accountability -------------------------


def test_hazard_falsified_by_survival_while_adjacent():
    from ouro2.induce import induce

    # Avatar 5 walks along a color-9 wall for many steps, dies ONCE next to
    # it: survival evidence must refute the hazard. A second color (7) seen
    # only at the death stays lethal.
    tl = Timeline()
    def g(x, extra=None):
        cells = {(xx, 12): 9 for xx in range(8, 20)}  # wall above the walk
        cells[(x, 13)] = 5
        cells.update(extra or {})
        return put(EMPTY, cells)
    for i in range(8, 18):
        append_step(tl, g(i), ActionSpec(4), g(i + 1))
    death = put(EMPTY, {(18, 13): 5, (19, 13): 7, (18, 12): 9})
    tl.append(g(18), ActionSpec(4), death, "GAME_OVER", 0, 0)
    model = induce(tl)
    from ouro2.rules import HazardRule
    hazards = [r for r in model.rules if isinstance(r, HazardRule)]
    lethal = set().union(*(h.colors for h in hazards)) if hazards else set()
    assert 9 not in lethal  # survived adjacent 10x -> falsified
    assert 7 in lethal  # only ever seen at the death


def test_backtest_penalizes_predicted_death_on_survival():
    from ouro2.induce import evaluate
    from ouro2.rules import Binding, HazardRule

    # Model wrongly claims color 9 kills on adjacency; the avatar stands
    # next to a 9 and lives. Grid equality must not absolve the false
    # hazard — it must count as a contradiction.
    binding = Binding(avatar_color=5)
    before = put(EMPTY, {(10, 10): 5, (10, 9): 9})
    tl = Timeline()
    append_step(tl, before, ActionSpec(7), before)  # survived, unchanged
    report = evaluate((HazardRule(colors=frozenset({9})),), tl, binding)
    assert report.contradictions == 1 and report.support == 0


def test_soft_lock_reset_requires_movement_to_have_worked():
    from ouro2.director import Director
    from ouro2.timeline import RESET

    class View:
        state = "NOT_FINISHED"
        levels_completed = 0
        full_reset = False
        available_actions = [1, 2, 3, 4]
        def __init__(self, grid):
            self.grid = grid

    def drive(worked_first: bool) -> list[str]:
        d = Director()
        g0 = put(EMPTY, {(10, 10): 5})
        g1 = put(EMPTY, {(11, 10): 5})
        d.choose(View(g0))
        if worked_first:  # one move that visibly worked this level
            d.last_action = ActionSpec(1)
            d.choose(View(g1))
        reasons = []
        cur = g1 if worked_first else g0
        for _ in range(10):  # then moves go dead
            d.last_action = ActionSpec(1)
            a = d.choose(View(cur))
            reasons.append(a.reason)
        return reasons

    assert any("soft-lock" in r for r in drive(True))
    assert not any("soft-lock" in r for r in drive(False))


# -- generalization pass: evidence-relative thresholds -----------------------


def test_diagonal_avatar_binds():
    # The old axis-jump gate (single-axis, 1-8) rejected diagonal movers;
    # recurrence is the evidence now.
    tl = Timeline()
    def g(x, y):
        return put(EMPTY, {(x, y): 5})
    for i in range(6):
        append_step(tl, g(10 + i, 10 + i), ActionSpec(4), g(11 + i, 11 + i))
    assert rebind(tl).avatar_color == 5


def test_inert_cell_suppression_decays():
    g = put(EMPTY, {(3, 3): 5, (30, 30): 6})
    ex = Explorer()
    for _ in range(2):  # (3,3) proven inert twice
        ex.note_result("s", ActionSpec(6, 3, 3), changed=False, grid=g)
    assert (3, 3) not in ex._ranked_clicks(g)  # suppressed while fresh
    ex.clock += 200  # ...but the suppression decays
    assert (3, 3) in ex._ranked_clicks(g)


def test_counter_eq_goal_rejected_by_negative_example():
    from ouro2.induce import infer_goal_candidates
    from ouro2.rules import Binding

    # Level completes with 2 of color 7 consumed — but an EARLIER state in
    # the level already had exactly 2 consumed without completing, so
    # counter_eq(7, 2) is refuted by the negative example.
    binding = Binding(avatar_color=5)
    def g(n_pellets, ax):
        cells = {(x, 40): 7 for x in range(n_pellets)}
        cells[(ax, 41)] = 5
        return put(EMPTY, cells)
    tl = Timeline()
    append_step(tl, g(3, 0), ActionSpec(4), g(1, 1))   # consumed 2 already
    append_step(tl, g(1, 1), ActionSpec(4), g(1, 2))   # wandered
    tl.append(g(1, 2), ActionSpec(4), g(0, 3), "NOT_FINISHED", 0, 1)  # level up
    goals = infer_goal_candidates(tl, binding)
    assert all(
        not (goal.kind == "counter_eq" and goal.color == 7 and goal.count == 2)
        for goal in goals
    )


# -- generalization pass: reversible masks -----------------------------------


def test_masks_rederive_and_shrink_with_evidence():
    from ouro2.director import Director

    # A mask must follow the CURRENT evidence: when re-induction stops
    # supporting a masked cell, the mask releases it (old behavior: masks
    # were monotone unions and never shrank).
    d = Director()
    d.mask_volatile = frozenset({123})

    class FakeModel:
        volatile = frozenset()
        depleting = frozenset()

        class binding:
            avatar_color = None

    import ouro2.director as director_mod

    real_induce = director_mod.induce
    director_mod.induce = lambda *a, **k: FakeModel()
    try:
        for i in range(5):
            append_step(d.timeline, EMPTY, ActionSpec(1), EMPTY)
        d._maybe_reinduce()
    finally:
        director_mod.induce = real_induce
    assert d.mask_volatile == frozenset()
