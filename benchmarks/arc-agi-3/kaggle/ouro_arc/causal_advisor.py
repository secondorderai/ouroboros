"""Qwen physicist/critic orchestration for autonomous Python world models."""

from __future__ import annotations

import json
import os
import hashlib
from dataclasses import dataclass
from typing import Any

from .actions import ActionSpec
from .advisor import ModelAdvisor
from .autonomous_model import (
    AutonomousWorldModel,
    CertificationResult,
    normalize_generated_protocol,
)
from .shared_mechanics import HelperProposal, HelperTestCase, SharedMechanicsRegistry
from .world_model import perceive_grid

MODEL_PROPOSAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "model_source": {"type": "string"},
        "notes": {"type": "string"},
        "experiment": {
            "type": ["object", "null"],
            "properties": {
                "action": {"type": "integer"},
                "x": {"type": ["integer", "null"]},
                "y": {"type": ["integer", "null"]},
            },
            "required": ["action"],
        },
        "helpers": {
            "type": "array",
            "maxItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "source": {"type": "string"},
                    "tests": {
                        "type": "array",
                        "minItems": 5,
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string"},
                                "args": {"type": "array"},
                                "kwargs": {"type": ["object", "null"]},
                                "expected": {},
                            },
                            "required": ["kind", "args"],
                        },
                    },
                },
                "required": ["name", "source", "tests"],
            },
        },
    },
    "required": ["model_source", "notes", "experiment", "helpers"],
    "additionalProperties": False,
}

MODEL_CRITIQUE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["accept", "revise", "reject"]},
        "issues": {"type": "array", "items": {"type": "string"}},
        "counterexample_indexes": {"type": "array", "items": {"type": "integer"}},
        "approved_helpers": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "issues", "counterexample_indexes", "approved_helpers"],
    "additionalProperties": False,
}

MODEL_SYSTEM_PROMPT = (
    "You are the physicist for an unknown ARC-AGI-3 game. Author a complete pure-Python "
    "executable world model using only observations and actions provided in the prompt. "
    "Never access files, environment variables, game implementations, processes, or network. "
    "Return one strict JSON object matching the supplied schema, without markdown. The Python "
    "source must define parse_observation, available_actions, step, render, is_goal, and canonicalize. "
    "It may also define progress_score. step always receives an action dictionary with integer "
    "field action and optional integer x and y fields. Never compare the entire action to an integer. "
    "Do not invent x or y when the observed ModelActions contain only action. If different controlled "
    "actions share an effect signature, consider action-independent passive tick dynamics. "
    "model_source must contain the complete executable Python source, never a title, description, "
    "filename, or pseudocode. Think concisely, reserve at least half the token budget for the final "
    "JSON, and keep model_source below 120 lines. Preserve the starter no-op behavior when evidence "
    "does not justify a more complex rule. Revise the supplied current source instead of restarting. "
    "Return exactly the keys model_source (string), notes "
    "(string), experiment (object or null), and helpers (array). Keep helpers empty unless the prompt "
    "explicitly permits distilling one generic helper from a previously certified model."
)

CRITIC_SYSTEM_PROMPT = (
    "You are an independent causal-model critic. Find counterexamples, hidden state missing from "
    "the representation, coordinate-specific exceptions, and simpler causal rules. Return one "
    "strict JSON object without markdown. Think for at most 1000 tokens and reserve output for the "
    "final verdict. Return exactly verdict (accept, revise, or reject), issues (string array), and "
    "counterexample_indexes (integer array), and approved_helpers (string array). Approve a helper "
    "only when it is generic and its transformation tests are sufficient. verdict is advisory for "
    "planning but authoritative for helper promotion. Accept only a model that explains the complete history."
)


@dataclass(frozen=True)
class CausalDeliberation:
    accepted: bool
    model_version: str | None
    experiment: ActionSpec | None
    helper_results: tuple[str, ...]
    calls: int
    verdict: str
    issues: tuple[str, ...]
    reason: str = ""
    helper_proposals: tuple[HelperProposal, ...] = ()


class CausalPhysicist:
    def __init__(self, advisor: ModelAdvisor, registry: SharedMechanicsRegistry) -> None:
        self.advisor = advisor
        self.registry = registry

    def deliberate(
        self,
        model: AutonomousWorldModel,
        *,
        current_grid: list[list[int]],
        available_actions: set[int],
        image: bytes | None,
        defer_helpers: bool = False,
    ) -> CausalDeliberation:
        model.set_helpers_source(self.registry.source_bundle())
        prompt = self._proposal_prompt(model, current_grid, available_actions)
        parent = model.best
        proposal = self.advisor.complete_json(
            prompt,
            MODEL_PROPOSAL_SCHEMA,
            image=image,
            system_prompt=MODEL_SYSTEM_PROMPT,
            purpose="world-model-physicist",
        )
        if proposal is None:
            model.record_deliberation({"role": "physicist", "prompt": prompt, "response": None, "status": "failure"})
            return CausalDeliberation(False, None, None, (), 1, "failure", (), "physicist returned no proposal")
        model.record_deliberation({"role": "physicist", "prompt": prompt, "response": proposal, "status": "success"})
        raw_source = _source_text(proposal.get("model_source"))
        source = normalize_generated_protocol(raw_source)
        if source != raw_source:
            model.record_deliberation(
                {
                    "role": "protocol-normalizer",
                    "status": "success",
                    "raw_source": raw_source,
                    "normalized_source": source,
                }
            )
        candidate = model.add_candidate(
            source,
            critic_verdict="pending",
            source_parent=parent.version if parent else None,
            notes=str(proposal.get("notes", "")),
        )
        if candidate is None:
            return CausalDeliberation(False, None, _experiment(proposal, available_actions), (), 1, "reject", (), "source validation failed")
        replay = candidate.certification
        validation_reason = "valid source"
        critique_prompt = self._critique_prompt(
            model,
            source,
            validation_reason,
            replay,
            proposal,
        )
        critique = self.advisor.complete_json(
            critique_prompt,
            MODEL_CRITIQUE_SCHEMA,
            image=image,
            system_prompt=CRITIC_SYSTEM_PROMPT,
            purpose="world-model-critic",
            max_new_tokens=int(os.getenv("OURO_ARC_MODEL_CRITIC_MAX_NEW_TOKENS", "4096")),
        )
        if critique is None:
            model.record_deliberation({"role": "critic", "prompt": critique_prompt, "response": None, "status": "failure"})
            model.update_critic(
                candidate.version,
                verdict="failure",
            )
            return CausalDeliberation(True, candidate.version, _experiment(proposal, available_actions), (), 2, "failure", (), "critic returned no result")
        model.record_deliberation({"role": "critic", "prompt": critique_prompt, "response": critique, "status": "success"})
        verdict = str(critique.get("verdict", "reject")).lower()
        issues = tuple(str(item)[:500] for item in critique.get("issues", []) if str(item).strip())
        counterexamples = tuple(
            int(item)
            for item in critique.get("counterexample_indexes", [])
            if isinstance(item, int)
        )
        candidate = model.update_critic(
            candidate.version,
            verdict=verdict,
            issues=issues,
            counterexample_indexes=counterexamples,
        ) or candidate

        approved = {
            str(item) for item in critique.get("approved_helpers", []) if str(item).strip()
        }
        helper_results: list[str] = []
        helper_proposals: tuple[HelperProposal, ...] = ()
        if candidate.certified and verdict == "accept":
            helper_proposals = _helper_proposals(
                proposal,
                model.game_id,
                approved,
                replay_passed=True,
            )
            if not defer_helpers:
                for helper in helper_proposals:
                    result = self.registry.promote(helper)
                    helper_results.append(f"{helper.name}:{result.reason}")
        return CausalDeliberation(
            accepted=True,
            model_version=candidate.version,
            experiment=_experiment(proposal, available_actions),
            helper_results=tuple(helper_results),
            calls=2,
            verdict=verdict,
            issues=issues,
            reason="critic feedback retained" if verdict != "accept" else "",
            helper_proposals=helper_proposals,
        )

    def _proposal_prompt(
        self,
        model: AutonomousWorldModel,
        current_grid: list[list[int]],
        available_actions: set[int],
    ) -> str:
        best = model.best
        evidence = _evidence_bundle(model, current_grid)
        prompt = (
            "Revise the executable causal theory. Complete-history replay is authoritative. "
            "Use generic mechanics and explicit latent state such as selection, phase, carried "
            "objects, occupancy, counters, or direction when evidence requires them. Avoid game IDs, "
            "fixed board coordinates, and replay tables. The global `mechanics` capability provides "
            "components, movement, pushing, carrying, transport, toggles, recoloring, spawning, "
            "neighborhood transforms, graph paths, composition, and goal helpers.\n"
            f"Game-local public identifier (never embed in source): {model.game_id}\n"
            f"Legal action IDs: {sorted(available_actions)}\n"
            "PROTOCOL VERSION 2: ModelAction is exactly {\"action\": int, \"x\"?: int, \"y\"?: int}. "
            "step(state, action) receives this dictionary. Controller reason/source labels never describe "
            "game physics. parse_observation receives list[list[int]] and is called once per attempt; the "
            "verifier then advances the returned latent state sequentially through every action. "
            "render(state) must return list[list[int]]. Exact delta_cells entries are "
            "[x,y,before_color,after_color]. changed_regions are separate local effects, not one "
            "combined crop. Shared cross-action signatures suggest passive tick dynamics.\n"
            f"Evidence bundle: {evidence}\n"
            f"Current source:\n{best.source if best else _starter_source()}\n"
            f"Current critic verdict: {best.critic_verdict if best else 'none'}\n"
            f"Current critic issues: {json.dumps(list(best.critic_issues) if best else [])}\n"
            f"Current replay failure: {json.dumps(model.summary().get('last_mismatch'), separators=(',', ':'))}\n"
            f"{self.registry.prompt_summary()}\n"
            + (
                "The existing model was certified before this revision. You may include at most one "
                "generic helper with color, coordinate, shape, size, and object-count tests."
                if best is not None and best.certified
                else "Set helpers=[]; no prior model is certified enough for helper distillation."
            )
        )
        return prompt

    @staticmethod
    def _critique_prompt(
        model: AutonomousWorldModel,
        source: str,
        validation_reason: str,
        replay: CertificationResult,
        proposal: dict[str, Any],
    ) -> str:
        failures = [
            {
                "index": item.index,
                "episode": item.episode,
                "kind": item.kind,
                "detail": item.detail,
                "evidence": item.evidence,
            }
            for item in replay.failures[:16]
        ]
        return (
            "Review this proposed world model against the verifier result. Prefer a smaller causal "
            "representation over coordinate or transition-index special cases. Do not rewrite code. "
            "Use verdict=accept only when complete-history replay passed; otherwise use revise or reject.\n"
            f"Validation reason: {validation_reason or 'valid source'}\n"
            f"Replay: passed={replay.passed}/{replay.total}; failures={json.dumps(failures)}\n"
            f"Model source:\n{source}\n"
            f"Generic helper candidates: {json.dumps(proposal.get('helpers', []), separators=(',', ':'))}\n"
            f"Timeline records available={len(model.timeline)}"
        )


def _source_text(value: Any) -> str:
    if isinstance(value, list):
        return "\n".join(str(line) for line in value).strip()
    text = str(value or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text


def _experiment(payload: dict[str, Any], available_actions: set[int]) -> ActionSpec | None:
    raw = payload.get("experiment")
    if not isinstance(raw, dict):
        return None
    try:
        spec = ActionSpec.from_json(raw)
    except (TypeError, ValueError):
        return None
    if spec.action not in available_actions:
        return None
    return ActionSpec(spec.action, spec.x, spec.y, "Qwen discriminating experiment", "autonomous-probe")


def _helper_proposals(
    payload: dict[str, Any],
    game_id: str,
    approved: set[str],
    replay_passed: bool,
) -> tuple[HelperProposal, ...]:
    result: list[HelperProposal] = []
    raw_helpers = payload.get("helpers", [])
    if not isinstance(raw_helpers, list):
        return ()
    for raw in raw_helpers:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        tests: list[HelperTestCase] = []
        for test in raw.get("tests", []):
            if not isinstance(test, dict) or not isinstance(test.get("args", []), list):
                continue
            tests.append(
                HelperTestCase(
                    kind=str(test.get("kind", "")),
                    args=tuple(test.get("args", [])),
                    kwargs=test.get("kwargs") if isinstance(test.get("kwargs"), dict) else None,
                    expected=test.get("expected"),
                )
            )
        if name:
            result.append(
                HelperProposal(
                    name=name,
                    source=_source_text(raw.get("source")),
                    tests=tuple(tests),
                    source_game=game_id,
                    replay_passed=replay_passed,
                    critic_approved=name in approved,
                )
            )
    return tuple(result)


def _compact_record(record: dict[str, Any]) -> dict[str, Any]:
    change = _change_summary(record["before_grid"], record["after_grid"])
    return {
        "i": record["index"],
        "e": record.get("episode", 0),
        "l": record["level"],
        "a": record["action"],
        "s": [record["before_state"], record["after_state"]],
        "goal": bool(record["goal"]),
        "n": change["changed_count"],
        "box": change["bounds"],
    }


def _evidence_bundle(
    model: AutonomousWorldModel,
    current_grid: list[list[int]],
) -> str:
    records = [record.to_json() for record in model.timeline]
    compact = [_compact_record(record) for record in records]
    action_stats: dict[str, dict[str, Any]] = {}
    signature_actions: dict[str, set[str]] = {}
    first_by_action: dict[str, int] = {}
    changed_rank: list[tuple[int, int]] = []
    selected: set[int] = set()
    for item in compact:
        action_key = json.dumps(item["a"], sort_keys=True, separators=(",", ":"))
        first_by_action.setdefault(action_key, int(item["i"]))
        stats = action_stats.setdefault(
            action_key,
            {
                "count": 0,
                "noops": 0,
                "goals": 0,
                "total_changed": 0,
                "min_changed": None,
                "max_changed": 0,
                "effect_signatures": {},
            },
        )
        stats["count"] += 1
        stats["noops"] += int(item["n"] == 0)
        stats["goals"] += int(item["goal"])
        stats["total_changed"] += int(item["n"])
        stats["min_changed"] = (
            int(item["n"])
            if stats["min_changed"] is None
            else min(int(stats["min_changed"]), int(item["n"]))
        )
        stats["max_changed"] = max(int(stats["max_changed"]), int(item["n"]))
        record = records[int(item["i"])]
        signature = _effect_signature(record["before_grid"], record["after_grid"])
        stats["effect_signatures"][signature] = stats["effect_signatures"].get(signature, 0) + 1
        signature_actions.setdefault(signature, set()).add(action_key)
        changed_rank.append((int(item["n"]), int(item["i"])))
        if item["goal"] or item["s"][0] != item["s"][1]:
            selected.add(int(item["i"]))
    selected.update(first_by_action.values())
    selected.update(index for _count, index in sorted(changed_rank, reverse=True)[:4])
    selected.update(range(max(0, len(records) - 3), len(records)))
    if model.last_mismatch is not None and model.last_mismatch.index >= 0:
        selected.update(
            index
            for index in range(model.last_mismatch.index - 1, model.last_mismatch.index + 2)
            if 0 <= index < len(records)
        )

    details: list[dict[str, Any]] = []
    for index in sorted(selected):
        record = records[index]
        change = _change_summary(record["before_grid"], record["after_grid"], include_crops=True)
        details.append(
            {
                "i": index,
                "action": record["action"],
                "object_tracks": _object_track_summary(
                    record["before_grid"],
                    record["after_grid"],
                ),
                **change,
            }
        )

    for stats in action_stats.values():
        stats["mean_changed"] = round(stats["total_changed"] / stats["count"], 2)

    timeline_hash = hashlib.sha256(
        json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    payload: dict[str, Any] = {
        "timeline_count": len(records),
        "timeline_hash": timeline_hash,
        "current_grid": _grid_text(current_grid),
        "current_objects": perceive_grid(current_grid).summary(max_objects=20),
        "action_stats": action_stats,
        "cross_action_effects": [
            {"signature": signature, "actions": sorted(actions)}
            for signature, actions in sorted(signature_actions.items())
            if len(actions) > 1
        ],
        "timeline": [_compact_timeline_line(item) for item in compact],
        "selected_transitions": details,
    }
    limit = max(8000, int(os.getenv("OURO_ARC_WORLD_MODEL_PROMPT_MAX_CHARS", "24000")))
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    while len(encoded) > limit and payload["selected_transitions"]:
        payload["selected_transitions"].pop()
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    if len(encoded) > limit:
        payload["current_objects"] = "omitted to fit prompt budget"
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    while len(encoded) > limit and len(payload["timeline"]) > 1:
        payload["timeline"] = payload["timeline"][-max(1, len(payload["timeline"]) // 2) :]
        payload["timeline_truncated"] = True
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return encoded


def _effect_signature(before: list[list[int]], after: list[list[int]]) -> str:
    changed: list[tuple[int, int]] = []
    for y in range(max(len(before), len(after))):
        width = max(
            len(before[y]) if y < len(before) else 0,
            len(after[y]) if y < len(after) else 0,
        )
        for x in range(width):
            if _cell(before, x, y) != _cell(after, x, y):
                changed.append((x, y))
    if not changed:
        return "noop"
    flows = _color_flow_summary(before, after, changed)
    color_signature = ";".join(
        f"{item['from']}>{item['to']}:{item['count']}"
        for item in flows
    )
    motions = [
        item
        for item in _object_track_summary(before, after)
        if item.get("event") == "changed"
        and item.get("shape_same")
        and item.get("center_delta") != [0, 0]
    ]
    motion_signature = ";".join(
        f"move{item['color']}:{item['center_delta'][0]},{item['center_delta'][1]}"
        for item in motions
    )
    return color_signature + (f"|{motion_signature}" if motion_signature else "")


def _object_track_summary(
    before: list[list[int]],
    after: list[list[int]],
    *,
    limit: int = 16,
) -> list[dict[str, Any]]:
    left = list(perceive_grid(before).objects)
    right = list(perceive_grid(after).objects)
    unmatched = set(range(len(right)))
    tracks: list[dict[str, Any]] = []
    for source in sorted(left, key=lambda item: (item.color, -item.size, item.bounds)):
        candidates = [
            index
            for index in unmatched
            if right[index].color == source.color
        ]
        if not candidates:
            tracks.append(
                {
                    "color": source.color,
                    "event": "removed",
                    "cells": source.size,
                    "box": list(source.bounds),
                }
            )
            continue
        index = min(
            candidates,
            key=lambda candidate: (
                abs(source.size - right[candidate].size) * 8
                + abs(source.center[0] - right[candidate].center[0])
                + abs(source.center[1] - right[candidate].center[1]),
                right[candidate].bounds,
            ),
        )
        target = right[index]
        unmatched.remove(index)
        if (
            source.bounds == target.bounds
            and source.size == target.size
            and source.shape_hash == target.shape_hash
        ):
            continue
        tracks.append(
            {
                "color": source.color,
                "event": "changed",
                "cells": [source.size, target.size],
                "box": [list(source.bounds), list(target.bounds)],
                "center_delta": [
                    target.center[0] - source.center[0],
                    target.center[1] - source.center[1],
                ],
                "shape_same": source.shape_hash == target.shape_hash,
            }
        )
    for index in sorted(unmatched, key=lambda item: (right[item].color, right[item].bounds)):
        target = right[index]
        tracks.append(
            {
                "color": target.color,
                "event": "spawned",
                "cells": target.size,
                "box": list(target.bounds),
            }
        )
    tracks.sort(
        key=lambda item: (
            0 if item["event"] == "changed" else 1,
            -max(item["cells"]) if isinstance(item["cells"], list) else -item["cells"],
            item["color"],
            json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    )
    return tracks[:limit]


def _compact_timeline_line(item: dict[str, Any]) -> str:
    action = item["a"]
    coordinates = ""
    if action.get("x") is not None or action.get("y") is not None:
        coordinates = f"@{action.get('x')},{action.get('y')}"
    state = "" if item["s"][0] == item["s"][1] else f"|s={item['s'][0]}>{item['s'][1]}"
    return (
        f"{item['i']}|e={item['e']}|l={item['l']}|a={action['action']}{coordinates}"
        f"|d={item['n']}|g={int(item['goal'])}{state}"
    )


def _change_summary(
    before: list[list[int]],
    after: list[list[int]],
    *,
    include_crops: bool = False,
) -> dict[str, Any]:
    changed: list[tuple[int, int]] = []
    for y in range(max(len(before), len(after))):
        left = before[y] if y < len(before) else []
        right = after[y] if y < len(after) else []
        for x in range(max(len(left), len(right))):
            if (left[x] if x < len(left) else None) != (right[x] if x < len(right) else None):
                changed.append((x, y))
    if not changed:
        return {"changed_count": 0, "bounds": None}
    min_x = min(x for x, _y in changed)
    max_x = max(x for x, _y in changed)
    min_y = min(y for _x, y in changed)
    max_y = max(y for _x, y in changed)
    result: dict[str, Any] = {
        "changed_count": len(changed),
        "bounds": [min_x, min_y, max_x, max_y],
    }
    if include_crops:
        result["color_flows"] = _color_flow_summary(before, after, changed)
        result["delta_cells"] = [
            [x, y, _cell(before, x, y), _cell(after, x, y)]
            for x, y in changed[:96]
        ]
        if len(changed) > 96:
            result["delta_cells_truncated"] = len(changed) - 96
        result["changed_regions"] = [
            _changed_region_summary(before, after, component)
            for component in _changed_components(changed)[:8]
        ]
    return result


def _cell(grid: list[list[int]], x: int, y: int) -> int | None:
    if y < 0 or y >= len(grid) or x < 0 or x >= len(grid[y]):
        return None
    return grid[y][x]


def _changed_components(changed: list[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    remaining = set(changed)
    components: list[list[tuple[int, int]]] = []
    while remaining:
        start = min(remaining, key=lambda item: (item[1], item[0]))
        remaining.remove(start)
        frontier = [start]
        component: list[tuple[int, int]] = []
        while frontier:
            x, y = frontier.pop()
            component.append((x, y))
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    frontier.append(neighbor)
        components.append(sorted(component, key=lambda item: (item[1], item[0])))
    return sorted(
        components,
        key=lambda item: (-len(item), min(y for _x, y in item), min(x for x, _y in item)),
    )


def _changed_region_summary(
    before: list[list[int]],
    after: list[list[int]],
    component: list[tuple[int, int]],
) -> dict[str, Any]:
    min_x = min(x for x, _y in component)
    max_x = max(x for x, _y in component)
    min_y = min(y for _x, y in component)
    max_y = max(y for _x, y in component)
    height = max(len(before), len(after))
    width = max(
        max((len(row) for row in before), default=0),
        max((len(row) for row in after), default=0),
    )
    crop_x0 = max(0, min_x - 1)
    crop_y0 = max(0, min_y - 1)
    crop_x1 = min(width - 1, max_x + 1, crop_x0 + 15)
    crop_y1 = min(height - 1, max_y + 1, crop_y0 + 15)
    return {
        "count": len(component),
        "bounds": [min_x, min_y, max_x, max_y],
        "crop_bounds": [crop_x0, crop_y0, crop_x1, crop_y1],
        "before": _grid_text(
            [
                [_cell(before, x, y) if _cell(before, x, y) is not None else -1 for x in range(crop_x0, crop_x1 + 1)]
                for y in range(crop_y0, crop_y1 + 1)
            ]
        ),
        "after": _grid_text(
            [
                [_cell(after, x, y) if _cell(after, x, y) is not None else -1 for x in range(crop_x0, crop_x1 + 1)]
                for y in range(crop_y0, crop_y1 + 1)
            ]
        ),
    }


def _color_flow_summary(
    before: list[list[int]],
    after: list[list[int]],
    changed: list[tuple[int, int]],
) -> list[dict[str, Any]]:
    groups: dict[tuple[int | None, int | None], list[tuple[int, int]]] = {}
    for x, y in changed:
        groups.setdefault((_cell(before, x, y), _cell(after, x, y)), []).append((x, y))
    result: list[dict[str, Any]] = []
    for (left, right), cells in sorted(
        groups.items(),
        key=lambda item: (
            -len(item[1]),
            -1 if item[0][0] is None else item[0][0],
            -1 if item[0][1] is None else item[0][1],
        ),
    ):
        result.append(
            {
                "from": left,
                "to": right,
                "count": len(cells),
                "center": [
                    round(sum(x for x, _y in cells) / len(cells), 2),
                    round(sum(y for _x, y in cells) / len(cells), 2),
                ],
                "bounds": [
                    min(x for x, _y in cells),
                    min(y for _x, y in cells),
                    max(x for x, _y in cells),
                    max(y for _x, y in cells),
                ],
            }
        )
    return result


def _grid_text(grid: list[list[int]]) -> str:
    alphabet = "0123456789abcdef"
    return "/".join(
        "".join(alphabet[value] if 0 <= value < len(alphabet) else f"[{value}]" for value in row)
        for row in grid
    )


def _grid_rle(grid: list[list[int]]) -> str:
    rows: list[str] = []
    for row in grid:
        encoded: list[str] = []
        for value in row:
            if encoded and encoded[-1].split("x", 1)[0] == str(value):
                color, count = encoded[-1].split("x", 1)
                encoded[-1] = f"{color}x{int(count) + 1}"
            else:
                encoded.append(f"{int(value)}x1")
        rows.append(",".join(encoded))
    return ";".join(rows)


def _starter_source() -> str:
    return '''def parse_observation(grid, memory):
    return {"grid": [row[:] for row in grid], "memory": dict(memory), "goal": False}

def available_actions(state):
    return []

def step(state, action):
    return {"grid": [row[:] for row in state["grid"]], "memory": dict(state["memory"]), "goal": False}

def render(state):
    return state["grid"]

def is_goal(state):
    return bool(state.get("goal", False))

def canonicalize(state):
    return state
'''
