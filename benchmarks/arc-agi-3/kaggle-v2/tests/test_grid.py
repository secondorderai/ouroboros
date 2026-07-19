from ouro2 import grid


def make_rows(pairs):
    rows = [[0] * grid.SIZE for _ in range(grid.SIZE)]
    for x, y, c in pairs:
        rows[y][x] = c
    return rows


def test_to_grid_takes_last_frame_and_handles_empty():
    a = make_rows([(1, 1, 5)])
    b = make_rows([(2, 2, 7)])
    g = grid.to_grid([a, b])
    assert g is not None
    assert grid.cell(g, 2, 2) == 7
    assert grid.cell(g, 1, 1) == 0
    assert grid.to_grid([]) is None
    assert grid.to_grid(None) is None
    assert grid.to_grid([[]]) is None


def test_diff_reports_changed_cells():
    a = grid.from_rows(make_rows([(3, 4, 2)]))
    b = grid.from_rows(make_rows([(3, 4, 9), (5, 5, 1)]))
    assert grid.diff(a, b) == [(3, 4, 2, 9), (5, 5, 0, 1)]
    assert grid.diff(a, a) == []


def test_grid_key_stable_and_distinct():
    a = grid.from_rows(make_rows([(0, 0, 1)]))
    b = grid.from_rows(make_rows([(0, 0, 2)]))
    assert grid.grid_key(a) == grid.grid_key(a)
    assert grid.grid_key(a) != grid.grid_key(b)


def test_components_4_and_8_connectivity():
    # Two diagonal cells: separate under 4-conn, one object under 8-conn.
    g = grid.from_rows(make_rows([(1, 1, 3), (2, 2, 3)]))
    objs4 = grid.components(g)
    objs8 = grid.components(g, conn=8)
    assert len(objs4) == 2
    assert len(objs8) == 1
    assert objs8[0].size == 2


def test_components_skips_background_and_reports_shape():
    g = grid.from_rows(make_rows([(1, 1, 3), (2, 1, 3), (10, 10, 5)]))
    objs = grid.components(g)
    assert {o.color for o in objs} == {3, 5}
    bar = next(o for o in objs if o.color == 3)
    assert bar.bbox == (1, 1, 2, 1)
    assert bar.width == 2 and bar.height == 1
    # Same shape elsewhere hashes identically; different shape differs.
    g2 = grid.from_rows(make_rows([(5, 5, 3), (6, 5, 3)]))
    bar2 = grid.components(g2)[0]
    assert bar2.shape_hash == bar.shape_hash


def test_apply_cells_roundtrip():
    g = grid.from_rows(make_rows([]))
    g2 = grid.apply_cells(g, [(7, 8, 9)])
    assert grid.cell(g2, 7, 8) == 9
    assert grid.diff(g, g2) == [(7, 8, 0, 9)]
    assert grid.apply_cells(g, []) is g
