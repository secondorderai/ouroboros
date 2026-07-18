from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .objects import GridObject, segment_objects
from .render import frame_hash
from .transition_graph import ActionKey, TransitionGraph, _sort_key


@dataclass(frozen=True)
class PerceivedObject:
    color: int
    size: int
    bounds: tuple[int, int, int, int]
    center: tuple[int, int]
    shape_hash: str


@dataclass(frozen=True)
class ScenePerception:
    """Canonical, immutable perception derived only from the current pixels."""

    width: int
    height: int
    row_widths: tuple[int, ...]
    background: int | None
    objects: tuple[PerceivedObject, ...]
    pixel_key: str
    scene_key: str

    def summary(self, max_objects: int = 16) -> str:
        objects = self.objects[:max_objects]
        body = " | ".join(
            f"c={obj.color},shape={obj.shape_hash},cells={obj.size},"
            f"box={obj.bounds},center={obj.center}"
            for obj in objects
        )
        omitted = len(self.objects) - len(objects)
        suffix = f"; omitted={omitted}" if omitted else ""
        return (
            f"size={self.width}x{self.height}; background={self.background}; "
            f"objects=[{body}]{suffix}; scene_key={self.scene_key[:12]}"
        )


@dataclass(frozen=True)
class MechanicHypothesis:
    id: str
    action_key: ActionKey
    statement: str
    evidence: str
    deterministic_score: int
    preconditions: tuple[str, ...] = ()
    predicted_effects: tuple[str, ...] = ()
    predicted_score_change: bool | None = None
    supporting_observations: int = 0
    contradicting_observations: int = 0
    information_gain: int = 0
    risk: int = 0

    def prompt_line(self) -> str:
        score_prediction = (
            "unknown"
            if self.predicted_score_change is None
            else str(self.predicted_score_change).lower()
        )
        return (
            f"{self.id}: claim={self.statement}; "
            f"when={list(self.preconditions) or ['current scene']}; "
            f"predicts={list(self.predicted_effects) or ['unknown effect']}; "
            f"score_change={score_prediction}; evidence={self.evidence}; "
            f"support={self.supporting_observations}; "
            f"contradictions={self.contradicting_observations}; "
            f"information={self.information_gain}; risk={self.risk}; "
            f"cpu_prior={self.deterministic_score}"
        )


@dataclass(frozen=True)
class ActionEvaluation:
    action_key: ActionKey
    expected_score_gain: int
    information_gain: int
    novelty: int
    risk: int
    visits: int
    global_visits: int
    total: int
    confidence: int = 0
    contradictions: int = 0
    predicted_effects: tuple[str, ...] = ()


@dataclass(frozen=True)
class WorldModelPrediction:
    outcome: str
    effect: str
    support: int
    contradictions: int
    confidence: int
    source: str


@dataclass(frozen=True)
class MechanicTemplate:
    """Coordinate-free causal rule induced from observed transitions."""

    id: str
    scene_signature: str
    action_schema: str
    predicted_outcome: str
    predicted_effect: str
    support: int
    contradictions: int
    confidence: int


@dataclass(frozen=True)
class TransitionRecord:
    level: int
    from_key: str
    action_key: ActionKey
    to_key: str | None
    outcome: str
    effect: str
    before: ScenePerception
    after: ScenePerception

    def to_json(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "from_key": self.from_key,
            "action_key": list(self.action_key),
            "to_key": self.to_key,
            "outcome": self.outcome,
            "effect": self.effect,
            "before": perception_to_json(self.before),
            "after": perception_to_json(self.after),
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "TransitionRecord":
        raw_action = value["action_key"]
        if not isinstance(raw_action, (list, tuple)) or len(raw_action) != 3:
            raise ValueError("action_key must contain action, x, and y")
        action, x, y = raw_action
        return cls(
            level=int(value["level"]),
            from_key=str(value["from_key"]),
            action_key=(
                int(action),
                None if x is None else int(x),
                None if y is None else int(y),
            ),
            to_key=None if value.get("to_key") is None else str(value["to_key"]),
            outcome=str(value["outcome"]),
            effect=str(value["effect"]),
            before=perception_from_json(value["before"]),
            after=perception_from_json(value["after"]),
        )


def perceive_grid(grid: list[list[int]]) -> ScenePerception:
    """Return a canonical scene snapshot with explicit tie-breaking.

    No learned model, random iteration, or process-specific hash participates in
    this representation. Equal pixel grids therefore always produce equal
    perceptions across runs and machines.
    """

    row_widths = tuple(len(row) for row in grid)
    width = max(row_widths, default=0)
    height = len(grid)
    coverage: dict[int, int] = {}
    for row in grid:
        for color in row:
            if not isinstance(color, int):
                raise ValueError("grid colors must be integers")
            coverage[color] = coverage.get(color, 0) + 1
    background = (
        min(coverage, key=lambda color: (-coverage[color], color))
        if coverage
        else None
    )
    foreground = [
        _perceived_object(obj)
        for obj in segment_objects(grid)
        if obj.color != background
    ]
    foreground.sort(
        key=lambda obj: (
            obj.color,
            obj.shape_hash,
            obj.bounds,
            obj.size,
            obj.center,
        )
    )
    canonical = (
        width,
        height,
        row_widths,
        background,
        tuple(
            (obj.color, obj.size, obj.bounds, obj.center, obj.shape_hash)
            for obj in foreground
        ),
    )
    scene_key = hashlib.blake2b(
        repr(canonical).encode("ascii"),
        digest_size=16,
    ).hexdigest()
    return ScenePerception(
        width=width,
        height=height,
        row_widths=row_widths,
        background=background,
        objects=tuple(foreground),
        pixel_key=frame_hash(grid),
        scene_key=scene_key,
    )


def _perceived_object(obj: GridObject) -> PerceivedObject:
    return PerceivedObject(
        color=obj.color,
        size=obj.size,
        bounds=(obj.x0, obj.y0, obj.x1, obj.y1),
        center=obj.center,
        shape_hash=obj.shape_hash,
    )


def perception_to_json(perception: ScenePerception) -> dict[str, Any]:
    return {
        "width": perception.width,
        "height": perception.height,
        "row_widths": list(perception.row_widths),
        "background": perception.background,
        "objects": [
            {
                "color": obj.color,
                "size": obj.size,
                "bounds": list(obj.bounds),
                "center": list(obj.center),
                "shape_hash": obj.shape_hash,
            }
            for obj in perception.objects
        ],
        "pixel_key": perception.pixel_key,
        "scene_key": perception.scene_key,
    }


def perception_from_json(value: Any) -> ScenePerception:
    if not isinstance(value, dict):
        raise ValueError("perception must be an object")
    objects = []
    for raw in value.get("objects", []):
        if not isinstance(raw, dict):
            raise ValueError("perceived objects must be objects")
        bounds = tuple(int(item) for item in raw["bounds"])
        center = tuple(int(item) for item in raw["center"])
        if len(bounds) != 4 or len(center) != 2:
            raise ValueError("invalid perceived object geometry")
        objects.append(
            PerceivedObject(
                color=int(raw["color"]),
                size=int(raw["size"]),
                bounds=bounds,  # type: ignore[arg-type]
                center=center,  # type: ignore[arg-type]
                shape_hash=str(raw["shape_hash"]),
            )
        )
    return ScenePerception(
        width=int(value["width"]),
        height=int(value["height"]),
        row_widths=tuple(int(item) for item in value["row_widths"]),
        background=(
            None if value.get("background") is None else int(value["background"])
        ),
        objects=tuple(objects),
        pixel_key=str(value["pixel_key"]),
        scene_key=str(value["scene_key"]),
    )


class ExecutableWorldModel:
    """Deterministic transition model executed by CPU graph search.

    The model records observed action effects and only executes transitions whose
    repeated observations agree. Qwen may rank the hypotheses returned by
    ``hypotheses``; it never supplies executable actions to this model.
    """

    def __init__(self, graph: TransitionGraph | None = None) -> None:
        self.graph = graph or TransitionGraph()
        self.scenes: dict[str, ScenePerception] = {}
        self.effects: dict[tuple[int, str, ActionKey], dict[str, int]] = {}
        self.observation_count = 0
        self.novel_observation_count = 0
        self.records: list[TransitionRecord] = []
        self.prediction_attempts = 0
        self.prediction_outcome_correct = 0
        self.prediction_effect_correct = 0
        self.prediction_confidence_total = 0
        self.prediction_brier_total = 0.0
        self.prediction_calibration: dict[int, list[int]] = {}

    def register(self, key: str, perception: ScenePerception) -> None:
        self.scenes.setdefault(key, perception)

    def observe(
        self,
        level: int,
        from_key: str,
        action_key: ActionKey,
        to_key: str | None,
        outcome: str,
        effect: str,
        before: ScenePerception,
        after: ScenePerception,
    ) -> bool:
        prediction = self.predict(level, from_key, action_key, before)
        if prediction is not None:
            self.prediction_attempts += 1
            self.prediction_confidence_total += prediction.confidence
            if prediction.outcome == outcome:
                self.prediction_outcome_correct += 1
            effect_correct = prediction.effect == self._causal_effect_values(
                outcome, effect, before, after
            )
            if effect_correct:
                self.prediction_effect_correct += 1
            probability = prediction.confidence / 1000
            self.prediction_brier_total += (
                probability - (1.0 if effect_correct else 0.0)
            ) ** 2
            bucket = min(4, prediction.confidence // 200)
            bucket_counts = self.prediction_calibration.setdefault(bucket, [0, 0])
            bucket_counts[0] += 1
            bucket_counts[1] += int(effect_correct)
        self.register(from_key, before)
        if to_key is not None:
            self.register(to_key, after)
        edge = self.graph.neighbors(from_key).get(action_key)
        variant = (to_key, outcome)
        is_novel = edge is None or variant not in edge.observations
        self.graph.observe(from_key, action_key, to_key, outcome, level)
        effect_counts = self.effects.setdefault((level, from_key, action_key), {})
        if effect not in effect_counts:
            is_novel = True
        effect_counts[effect] = effect_counts.get(effect, 0) + 1
        self.observation_count += 1
        if is_novel:
            self.novel_observation_count += 1
        self.records.append(
            TransitionRecord(
                level=level,
                from_key=from_key,
                action_key=action_key,
                to_key=to_key,
                outcome=outcome,
                effect=effect,
                before=before,
                after=after,
            )
        )
        return is_novel

    def replay(self, records: Iterable[TransitionRecord | dict[str, Any]]) -> None:
        for raw in records:
            record = raw if isinstance(raw, TransitionRecord) else TransitionRecord.from_json(raw)
            self.observe(
                record.level,
                record.from_key,
                record.action_key,
                record.to_key,
                record.outcome,
                record.effect,
                record.before,
                record.after,
            )

    def search(
        self,
        start_key: str,
        candidate_provider: Callable[[str], Iterable[ActionKey]],
        max_depth: int,
        is_blocked: Callable[[ActionKey], bool],
        level: int = 0,
        allow_local_information_probe: bool = False,
    ) -> list[ActionKey] | None:
        path = self.graph.path_to_score(start_key, max_depth, is_blocked)
        if path:
            return path
        local = list(candidate_provider(start_key))
        local_frontier = self.graph.frontier_actions(start_key, local, is_blocked)
        if local_frontier:
            if allow_local_information_probe:
                probe = self.best_probe(level, start_key, local_frontier)
                return [probe.action_key] if probe is not None else None
            return None
        return self.graph.path_to_frontier(
            start_key,
            candidate_provider,
            max_depth,
            is_blocked,
            action_rank=lambda key, action_key: self._action_rank(
                level, key, action_key
            ),
        )

    def action_evaluation(
        self,
        level: int,
        key: str,
        action_key: ActionKey,
    ) -> ActionEvaluation:
        local_edge = self.graph.neighbors(key).get(action_key)
        profile = self._action_profile(level, action_key, key)
        total = sum(profile.values())
        if total:
            score_count = sum(
                count
                for (outcome, _effect), count in profile.items()
                if outcome == "score increased"
            )
            unsafe_count = sum(
                count
                for (outcome, effect), count in profile.items()
                if outcome in {"game over", "lost"} or effect == "unsafe"
            )
            expected_score_gain = (score_count * 1000) // total
            risk = (unsafe_count * 1000) // total
            squared = sum(count * count for count in profile.values())
            profile_uncertainty = ((total * total - squared) * 1000) // (
                total * total
            )
            majority = max(profile.values())
            contradictions = total - majority
            confidence = (majority * 1000) // total
        else:
            expected_score_gain = 0
            risk = 0
            profile_uncertainty = 1000
            contradictions = 0
            confidence = 0

        visits = local_edge.visits if local_edge is not None else 0
        global_visits = total
        if local_edge is None:
            if global_visits:
                novelty = max(100, 700 - global_visits * 20)
                information_gain = max(250, profile_uncertainty)
            else:
                novelty = 1000
                information_gain = 1000
        elif not local_edge.stable:
            novelty = 350
            information_gain = 1000
        else:
            novelty = max(0, 300 - visits * 50)
            information_gain = profile_uncertainty // max(1, visits)
        saturation_penalty = (
            min(global_visits, 50) * 15 if expected_score_gain == 0 else 0
        )
        total_score = (
            expected_score_gain * 4
            + information_gain * 2
            + novelty
            - risk * 5
            - visits * 10
            - saturation_penalty
        )
        return ActionEvaluation(
            action_key=action_key,
            expected_score_gain=expected_score_gain,
            information_gain=information_gain,
            novelty=novelty,
            risk=risk,
            visits=visits,
            global_visits=global_visits,
            total=total_score,
            confidence=confidence,
            contradictions=contradictions,
            predicted_effects=tuple(
                sorted({effect for (_outcome, effect) in profile})
            ),
        )

    def rank_actions(
        self,
        level: int,
        key: str,
        action_keys: Iterable[ActionKey],
    ) -> list[ActionEvaluation]:
        evaluations = {
            action_key: self.action_evaluation(level, key, action_key)
            for action_key in set(action_keys)
        }
        return sorted(
            evaluations.values(),
            key=lambda item: (-item.total, _sort_key(item.action_key)),
        )

    def best_probe(
        self,
        level: int,
        key: str,
        action_keys: Iterable[ActionKey],
        max_risk: int = 500,
    ) -> ActionEvaluation | None:
        ranked = self.rank_actions(level, key, action_keys)
        if not ranked:
            return None
        safe = [evaluation for evaluation in ranked if evaluation.risk <= max_risk]
        return (safe or ranked)[0]

    def _action_rank(
        self,
        level: int,
        key: str,
        action_key: ActionKey,
    ) -> tuple[int, tuple[int, int, int]]:
        evaluation = self.action_evaluation(level, key, action_key)
        return (-evaluation.total, _sort_key(action_key))

    def _action_profile(
        self,
        level: int,
        action_key: ActionKey,
        key: str | None = None,
    ) -> dict[tuple[str, str], int]:
        scene = self.scenes.get(key) if key is not None else None
        if scene is not None:
            contextual = self._profile_for(
                action_key,
                scene,
                require_scene_signature=True,
            )
            if contextual:
                return contextual
            generalized = self._profile_for(
                action_key,
                scene,
                require_scene_signature=False,
            )
            if generalized:
                return generalized

        # Compatibility fallback for callers that only have a level/action pair.
        profile: dict[tuple[str, str], int] = {}
        for record in self.records:
            if record.level == level and record.action_key == action_key:
                variant = (record.outcome, self._causal_effect(record))
                profile[variant] = profile.get(variant, 0) + 1
        return profile

    def _profile_for(
        self,
        action_key: ActionKey,
        scene: ScenePerception,
        require_scene_signature: bool,
    ) -> dict[tuple[str, str], int]:
        expected_action = self.action_schema(scene, action_key)
        expected_scene = self.scene_signature(scene)
        profile: dict[tuple[str, str], int] = {}
        for record in self.records:
            if self.action_schema(record.before, record.action_key) != expected_action:
                continue
            if (
                require_scene_signature
                and self.scene_signature(record.before) != expected_scene
            ):
                continue
            variant = (record.outcome, self._causal_effect(record))
            profile[variant] = profile.get(variant, 0) + 1
        return profile

    @staticmethod
    def scene_signature(scene: ScenePerception) -> str:
        """Describe scene composition without absolute object coordinates."""

        composition = tuple(
            sorted((obj.color, obj.size, obj.shape_hash) for obj in scene.objects)
        )
        canonical = (
            scene.width,
            scene.height,
            scene.background,
            composition,
        )
        return hashlib.blake2b(
            repr(canonical).encode("ascii"), digest_size=12
        ).hexdigest()

    @staticmethod
    def action_schema(scene: ScenePerception, action_key: ActionKey) -> str:
        """Map an action to a reusable semantic target instead of coordinates."""

        action, x, y = action_key
        if action != 6 or x is None or y is None:
            return f"action:{action}"
        containing = [
            obj
            for obj in scene.objects
            if obj.bounds[0] <= x <= obj.bounds[2]
            and obj.bounds[1] <= y <= obj.bounds[3]
        ]
        if containing:
            target = min(
                containing,
                key=lambda obj: (obj.size, obj.color, obj.shape_hash, obj.bounds),
            )
            relation = "inside"
        elif scene.objects:
            target = min(
                scene.objects,
                key=lambda obj: (
                    abs(obj.center[0] - x) + abs(obj.center[1] - y),
                    obj.color,
                    obj.shape_hash,
                    obj.size,
                ),
            )
            relation = "nearest"
        else:
            return "action:6:empty"
        size_bucket = min(5, target.size.bit_length() - 1)
        return (
            f"action:6:{relation}:color={target.color}:"
            f"size={size_bucket}:shape={target.shape_hash}"
        )

    @staticmethod
    def _causal_effect(record: TransitionRecord) -> str:
        return ExecutableWorldModel._causal_effect_values(
            record.outcome,
            record.effect,
            record.before,
            record.after,
        )

    @staticmethod
    def _causal_effect_values(
        outcome: str,
        effect: str,
        before: ScenePerception,
        after: ScenePerception,
    ) -> str:
        if outcome == "score increased":
            return "score-progress"
        if effect == "hud-only":
            return "hud-only"
        if before.scene_key == after.scene_key:
            return "scene-unchanged"
        if before.background != after.background:
            return "background-changed"
        before_shapes = sorted(
            (obj.color, obj.size, obj.shape_hash) for obj in before.objects
        )
        after_shapes = sorted(
            (obj.color, obj.size, obj.shape_hash) for obj in after.objects
        )
        if before_shapes == after_shapes:
            before_centers = sorted(
                (obj.color, obj.size, obj.shape_hash, obj.center)
                for obj in before.objects
            )
            after_centers = sorted(
                (obj.color, obj.size, obj.shape_hash, obj.center)
                for obj in after.objects
            )
            if before_centers != after_centers:
                return "entity-moved"
        if len(after.objects) > len(before.objects):
            return "entity-added"
        if len(after.objects) < len(before.objects):
            return "entity-removed"
        return "entity-transformed"

    def predict(
        self,
        level: int,
        key: str,
        action_key: ActionKey,
        scene: ScenePerception | None = None,
    ) -> WorldModelPrediction | None:
        """Predict from prior evidence only; callers may use this prequentially."""

        exact: dict[tuple[str, str], int] = {}
        for record in self.records:
            if record.from_key == key and record.action_key == action_key:
                variant = (record.outcome, self._causal_effect(record))
                exact[variant] = exact.get(variant, 0) + 1
        source = "exact"
        profile = exact
        current = scene or self.scenes.get(key)
        if not profile and current is not None:
            profile = self._profile_for(action_key, current, True)
            source = "context"
        if not profile and current is not None:
            profile = self._profile_for(action_key, current, False)
            source = "schema"
        if not profile:
            return None
        selected = min(
            profile,
            key=lambda variant: (-profile[variant], variant[0], variant[1]),
        )
        support = profile[selected]
        total = sum(profile.values())
        return WorldModelPrediction(
            outcome=selected[0],
            effect=selected[1],
            support=support,
            contradictions=total - support,
            confidence=(support * 1000) // total,
            source=source,
        )

    def prediction_metrics(self) -> dict[str, Any]:
        attempts = self.prediction_attempts
        return {
            "attempts": attempts,
            "outcome_correct": self.prediction_outcome_correct,
            "effect_correct": self.prediction_effect_correct,
            "outcome_accuracy": (
                self.prediction_outcome_correct / attempts if attempts else 0.0
            ),
            "effect_accuracy": (
                self.prediction_effect_correct / attempts if attempts else 0.0
            ),
            "mean_confidence": (
                self.prediction_confidence_total / (attempts * 1000)
                if attempts
                else 0.0
            ),
            "brier_score": (
                self.prediction_brier_total / attempts if attempts else 0.0
            ),
            "calibration": {
                f"{bucket * 20}-{(bucket + 1) * 20}": {
                    "attempts": counts[0],
                    "correct": counts[1],
                }
                for bucket, counts in sorted(self.prediction_calibration.items())
            },
        }

    def mechanic_templates(self) -> list[MechanicTemplate]:
        grouped: dict[tuple[str, str], dict[tuple[str, str], int]] = {}
        for record in self.records:
            key = (
                self.scene_signature(record.before),
                self.action_schema(record.before, record.action_key),
            )
            profile = grouped.setdefault(key, {})
            variant = (record.outcome, self._causal_effect(record))
            profile[variant] = profile.get(variant, 0) + 1
        result: list[MechanicTemplate] = []
        for (scene_signature, action_schema), profile in sorted(grouped.items()):
            selected = min(
                profile,
                key=lambda variant: (-profile[variant], variant[0], variant[1]),
            )
            total = sum(profile.values())
            support = profile[selected]
            template_id = hashlib.blake2b(
                f"{scene_signature}|{action_schema}".encode("ascii"),
                digest_size=8,
            ).hexdigest()
            result.append(
                MechanicTemplate(
                    id=template_id,
                    scene_signature=scene_signature,
                    action_schema=action_schema,
                    predicted_outcome=selected[0],
                    predicted_effect=selected[1],
                    support=support,
                    contradictions=total - support,
                    confidence=(support * 1000) // total,
                )
            )
        return result

    @staticmethod
    def needs_external_ranking(hypotheses: list[MechanicHypothesis]) -> bool:
        """Use an LLM only when deterministic evidence leaves a real choice."""

        if len(hypotheses) < 2:
            return False
        first, second = hypotheses[:2]
        margin = first.deterministic_score - second.deterministic_score
        return (
            margin <= 500
            or first.contradicting_observations > 0
            or first.information_gain >= 500
        )

    def hypotheses(
        self,
        level: int,
        key: str,
        candidate_keys: Iterable[ActionKey],
        is_blocked: Callable[[ActionKey], bool],
        limit: int = 8,
    ) -> list[MechanicHypothesis]:
        result: list[MechanicHypothesis] = []
        ordered_keys = [
            action_key
            for action_key in sorted(set(candidate_keys), key=_sort_key)
            if not is_blocked(action_key)
        ]
        evaluations = {
            action_key: self.action_evaluation(level, key, action_key)
            for action_key in ordered_keys
        }
        unsaturated = [
            action_key
            for action_key in ordered_keys
            if not self._globally_saturated(evaluations[action_key])
        ]
        for action_key in unsaturated or ordered_keys:
            if is_blocked(action_key):
                continue
            edge = self.graph.neighbors(key).get(action_key)
            evaluation = evaluations[action_key]
            profile = self._action_profile(level, action_key, key)
            profile_body = ",".join(
                f"{outcome}/{effect}:{count}"
                for (outcome, effect), count in sorted(profile.items())
            ) or "none"
            support = sum(profile.values())
            contradictions = support - max(profile.values(), default=0)
            preconditions = self._scene_preconditions(level, key)
            if edge is None:
                statement = "the action reveals an untested causal transition"
                evidence = f"local=unobserved; global_profile={profile_body}"
                predicted_effects = tuple(
                    sorted({effect for (_outcome, effect) in profile})
                ) or ("unknown effect",)
                predicted_score = None
            elif not edge.stable:
                statement = "the action is conditional and distinguishes competing effects"
                evidence = (
                    f"local_variants={len(edge.observations)}; "
                    f"global_profile={profile_body}; visits={edge.visits}"
                )
                predicted_effects = tuple(
                    sorted({effect for (_outcome, effect) in profile})
                ) or tuple(sorted({outcome for (_to_key, outcome) in edge.observations}))
                predicted_score = any(
                    outcome == "score increased" for (_to_key, outcome) in edge.observations
                )
            elif edge.outcome == "score increased":
                statement = "the action satisfies a known score-advancing precondition"
                evidence = f"stable score transition; global_profile={profile_body}; visits={edge.visits}"
                predicted_effects = ("progress",)
                predicted_score = True
            elif edge.outcome == "changed":
                effects = self.effects.get((level, key, action_key), {})
                statement = "the action deterministically changes scene entities"
                evidence = (
                    f"local_effects={dict(sorted(effects.items()))}; "
                    f"global_profile={profile_body}; visits={edge.visits}"
                )
                predicted_effects = tuple(sorted(effects)) or ("gameplay-change",)
                predicted_score = False
            elif edge.outcome == "no visible change":
                statement = "the action requires a precondition absent from this scene"
                evidence = f"stable local no-op; global_profile={profile_body}; visits={edge.visits}"
                predicted_effects = ("no visible change",)
                predicted_score = False
            else:
                statement = "the action may cross an unsafe terminal boundary"
                evidence = f"outcome={edge.outcome}; global_profile={profile_body}; visits={edge.visits}"
                predicted_effects = (edge.outcome,)
                predicted_score = False
            action, x, y = action_key
            hypothesis_id = f"h-a{action}-x{x if x is not None else 'n'}-y{y if y is not None else 'n'}"
            result.append(
                MechanicHypothesis(
                    id=hypothesis_id,
                    action_key=action_key,
                    statement=statement,
                    evidence=evidence,
                    deterministic_score=evaluation.total,
                    preconditions=preconditions,
                    predicted_effects=predicted_effects,
                    predicted_score_change=predicted_score,
                    supporting_observations=support,
                    contradicting_observations=contradictions,
                    information_gain=evaluation.information_gain,
                    risk=evaluation.risk,
                )
            )
        result.sort(
            key=lambda item: (-item.deterministic_score, _sort_key(item.action_key))
        )
        return result[:limit]

    @staticmethod
    def _globally_saturated(evaluation: ActionEvaluation) -> bool:
        return (
            evaluation.global_visits >= 24
            and evaluation.expected_score_gain == 0
        )

    def _scene_preconditions(self, level: int, key: str) -> tuple[str, ...]:
        scene = self.scenes.get(key)
        if scene is None:
            return (f"state={key[:8]}", f"level={level}")
        colors = sorted({obj.color for obj in scene.objects})
        return (
            f"level={level}",
            f"background={scene.background}",
            f"object_count={len(scene.objects)}",
            f"colors={colors}",
        )
