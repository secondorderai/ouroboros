from __future__ import annotations

import argparse
import html
import json
from collections import Counter
from pathlib import Path
from typing import Any


PALETTE = {
    0: "#111827",
    1: "#2563eb",
    2: "#dc2626",
    3: "#16a34a",
    4: "#facc15",
    5: "#9ca3af",
    6: "#ec4899",
    7: "#f97316",
    8: "#06b6d4",
    9: "#7c3aed",
}


def load_events(path: Path, game_id: str | None = None) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            event = json.loads(line)
            if game_id and event.get("game_id") != game_id:
                continue
            events.append(event)
    return events


def action_label(event: dict[str, Any]) -> str:
    action = event.get("action", {})
    name = f"ACTION{action.get('action')}"
    if action.get("action") == 6:
        name += f"({action.get('x')},{action.get('y')})"
    return name


def summarize(events: list[dict[str, Any]]) -> str:
    solvers = Counter(str(event.get("solver", "?")) for event in events)
    outcomes = Counter(str(event.get("outcome", "?")) for event in events)
    transitions = Counter(
        (
            str(event.get("before", {}).get("key", "?"))[:8],
            action_label(event),
            str(event.get("after", {}).get("key", "?"))[:8],
            str(event.get("outcome", "?")),
        )
        for event in events
    )
    state_visits = Counter(str(event.get("after", {}).get("key", "?"))[:8] for event in events)
    click_cycles = detect_click_cycles(events)

    lines = [
        f"events={len(events)}",
        "solvers=" + ",".join(f"{name}:{count}" for name, count in solvers.most_common()),
        "outcomes=" + ",".join(f"{name}:{count}" for name, count in outcomes.most_common()),
        "top_states=" + ",".join(f"{name}:{count}" for name, count in state_visits.most_common(8)),
        "top_transitions:",
    ]
    for (before, action, after, outcome), count in transitions.most_common(12):
        lines.append(f"  {count:4} {before} --{action}/{outcome}--> {after}")
    if click_cycles:
        lines.append("click_cycles:")
        for cycle, count in click_cycles[:8]:
            lines.append(f"  {count:4} {' -> '.join(cycle)}")
    return "\n".join(lines)


def detect_click_cycles(events: list[dict[str, Any]]) -> list[tuple[tuple[str, ...], int]]:
    keys = [
        str(event.get("after", {}).get("key", "?"))[:8]
        for event in events
        if int(event.get("action", {}).get("action", -1) or -1) == 6
    ]
    cycles: Counter[tuple[str, ...]] = Counter()
    for width in (2, 3, 4):
        for index in range(0, max(0, len(keys) - width * 2 + 1)):
            left = tuple(keys[index : index + width])
            right = tuple(keys[index + width : index + width * 2])
            if left == right and len(set(left)) > 1:
                cycles[left] += 1
    return cycles.most_common()


def render_grid(grid: list[list[int]]) -> str:
    if not grid:
        return ""
    rows: list[str] = []
    for row in grid:
        cells = []
        for value in row:
            color = PALETTE.get(int(value), "#ffffff")
            cells.append(f'<span style="background:{color}"></span>')
        rows.append("".join(cells))
    width = max((len(row) for row in grid), default=0)
    return (
        f'<div class="grid" style="grid-template-columns: repeat({width}, 7px)">'
        + "".join(rows)
        + "</div>"
    )


def write_html(events: list[dict[str, Any]], path: Path, limit: int = 240) -> None:
    rows: list[str] = []
    for index, event in enumerate(events[:limit], 1):
        before = str(event.get("before", {}).get("key", "?"))[:8]
        after = str(event.get("after", {}).get("key", "?"))[:8]
        frames = event.get("frames", {})
        after_grid = frames.get("after") if isinstance(frames, dict) else None
        frame_html = render_grid(after_grid) if isinstance(after_grid, list) else ""
        rows.append(
            "<tr>"
            f"<td>{index}</td>"
            f"<td>{html.escape(str(event.get('game_id', '')))}</td>"
            f"<td>{html.escape(before)} -> {html.escape(after)}</td>"
            f"<td>{html.escape(action_label(event))}</td>"
            f"<td>{html.escape(str(event.get('solver', '?')))}</td>"
            f"<td>{html.escape(str(event.get('outcome', '?')))}</td>"
            f"<td>{html.escape(str(event.get('diff', '')))}</td>"
            f"<td>{frame_html}</td>"
            "</tr>"
        )
    doc = """<!doctype html>
<meta charset="utf-8">
<title>OURO ARC Trace</title>
<style>
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ddd; padding: 4px 6px; vertical-align: top; }
.grid { display: grid; gap: 0; width: max-content; }
.grid span { width: 7px; height: 7px; display: block; }
</style>
<h1>OURO ARC Trace</h1>
<pre>""" + html.escape(summarize(events)) + """</pre>
<table>
<thead><tr><th>#</th><th>game</th><th>state</th><th>action</th><th>solver</th><th>outcome</th><th>diff</th><th>after frame</th></tr></thead>
<tbody>
""" + "\n".join(rows) + """
</tbody>
</table>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect OURO ARC JSONL traces.")
    parser.add_argument("trace", nargs="?", default="logs/ouro_arc_trace.jsonl")
    parser.add_argument("--game", default=None, help="Filter by game id, e.g. ft09")
    parser.add_argument("--html", default=None, help="Write an HTML trace table")
    parser.add_argument("--limit", type=int, default=240)
    args = parser.parse_args()

    events = load_events(Path(args.trace), args.game)
    print(summarize(events))
    if args.html:
        write_html(events, Path(args.html), limit=args.limit)
        print(f"wrote {args.html}")


if __name__ == "__main__":
    main()
