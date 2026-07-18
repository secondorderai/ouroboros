"""Versioned autonomous Python world models with deterministic certification."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable

from .actions import ActionSpec

MODEL_PROTOCOL_VERSION = 2

SAFE_IMPORTS = frozenset(
    {
        "collections",
        "copy",
        "dataclasses",
        "enum",
        "functools",
        "heapq",
        "itertools",
        "math",
        "operator",
        "statistics",
        "typing",
    }
)
REQUIRED_FUNCTIONS = frozenset(
    {
        "parse_observation",
        "available_actions",
        "step",
        "render",
        "is_goal",
        "canonicalize",
    }
)
BLOCKED_NAMES = frozenset(
    {
        "breakpoint",
        "compile",
        "eval",
        "exec",
        "globals",
        "getattr",
        "hasattr",
        "help",
        "input",
        "locals",
        "memoryview",
        "quit",
        "setattr",
        "exit",
        "vars",
        "__loader__",
        "__spec__",
    }
)
SENSITIVE_TEXT = (
    "environment_files",
    "arc_agi",
    "arcengine",
    "scorecard",
    "kaggle/input",
    "ouro_arc",
    "subprocess",
    "socket",
    "ctypes",
)


@dataclass(frozen=True)
class SourceValidation:
    valid: bool
    reason: str = ""
    ast_nodes: int = 0
    function_names: tuple[str, ...] = ()


@dataclass(frozen=True)
class CausalTransitionRecord:
    index: int
    episode: int
    level: int
    before_grid: list[list[int]]
    action: dict[str, Any]
    after_grid: list[list[int]]
    before_state: str
    after_state: str
    goal: bool

    def to_json(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "episode": self.episode,
            "level": self.level,
            "before_grid": self.before_grid,
            "action": self.action,
            "after_grid": self.after_grid,
            "before_state": self.before_state,
            "after_state": self.after_state,
            "goal": self.goal,
        }


@dataclass(frozen=True)
class ReplayFailure:
    index: int
    kind: str
    detail: str
    episode: int = 0
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CertificationResult:
    passed: int
    total: int
    failures: tuple[ReplayFailure, ...] = ()
    passed_indexes: tuple[int, ...] = ()
    final_state: Any = None
    final_state_hash: str | None = None
    final_episode: int | None = None

    @property
    def certified(self) -> bool:
        return self.passed == self.total and not self.failures

    @property
    def coverage(self) -> float:
        return self.passed / self.total if self.total else 0.0


@dataclass(frozen=True)
class ModelCandidate:
    version: str
    source: str
    certification: CertificationResult
    ast_nodes: int
    exception_count: int
    cross_level_coverage: int
    critic_approved: bool
    notes: str = ""
    critic_verdict: str = "pending"
    critic_issues: tuple[str, ...] = ()
    counterexample_indexes: tuple[int, ...] = ()
    source_parent: str | None = None
    revision: int = 0
    protocol_version: int = MODEL_PROTOCOL_VERSION

    @property
    def certified(self) -> bool:
        return self.certification.certified

    @property
    def rank_key(self) -> tuple[Any, ...]:
        critic_rank = {"accept": 0, "revise": 1, "pending": 2, "reject": 3, "failure": 4}.get(
            self.critic_verdict,
            5,
        )
        return (
            -self.certification.passed,
            -self.cross_level_coverage,
            len(self.certification.failures),
            critic_rank,
            self.exception_count,
            self.ast_nodes,
            self.version,
        )


@dataclass(frozen=True)
class AutonomousPlan:
    actions: tuple[ActionSpec, ...]
    state_hashes: tuple[str, ...]
    predicted_grids: tuple[list[list[int]], ...]
    predicted_states: tuple[Any, ...]
    expanded: int
    model_version: str
    objective: str = "goal"


@dataclass(frozen=True)
class DiscriminatingProbe:
    action: ActionSpec
    disagreement: int
    predictions: tuple[tuple[str, str], ...]


def validate_generated_source(source: str, *, helper: bool = False) -> SourceValidation:
    if not source.strip():
        return SourceValidation(False, "empty source")
    max_bytes = int(os.getenv("OURO_ARC_WORLD_MODEL_MAX_SOURCE_BYTES", "131072"))
    if len(source.encode("utf-8")) > max_bytes:
        return SourceValidation(False, "source too large")
    lowered = source.lower()
    for marker in SENSITIVE_TEXT:
        if marker in lowered:
            return SourceValidation(False, f"sensitive reference blocked: {marker}")
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        return SourceValidation(False, f"syntax error: {exc.msg}")
    functions: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name.split(".", 1)[0] for alias in node.names]
            if isinstance(node, ast.ImportFrom) and node.module:
                names.append(node.module.split(".", 1)[0])
            blocked = sorted(set(names) - SAFE_IMPORTS)
            if blocked:
                return SourceValidation(False, f"unsafe import: {', '.join(blocked)}")
        if isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            return SourceValidation(False, f"blocked name: {node.id}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return SourceValidation(False, f"dunder access blocked: {node.attr}")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith("__"):
            return SourceValidation(False, "dunder string blocked")
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            return SourceValidation(False, "global and nonlocal declarations are blocked")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
            operands = (node.left, node.right)
            count = next(
                (
                    int(item.value)
                    for item in operands
                    if isinstance(item, ast.Constant) and isinstance(item.value, int)
                ),
                0,
            )
            collection = any(isinstance(item, (ast.List, ast.Tuple, ast.Set)) for item in operands)
            if collection and count > 1_000_000:
                return SourceValidation(False, "excessive literal allocation blocked")
    if not helper:
        missing = REQUIRED_FUNCTIONS - set(functions)
        if missing:
            return SourceValidation(False, f"missing functions: {', '.join(sorted(missing))}")
        protocol_error = _protocol_v2_error(tree)
        if protocol_error:
            return SourceValidation(False, protocol_error)
    elif not functions:
        return SourceValidation(False, "helper source has no functions")
    return SourceValidation(True, ast_nodes=sum(1 for _ in ast.walk(tree)), function_names=tuple(sorted(functions)))


def normalize_generated_protocol(source: str) -> str:
    """Adapt common Qwen v1 action literals to the protocol-v2 dictionary."""

    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError:
        return source
    step = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "step"
            and len(node.args.args) >= 2
        ),
        None,
    )
    action_name = step.args.args[1].arg if step is not None else "action"

    class ProtocolNormalizer(ast.NodeTransformer):
        in_available_actions = False

        def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
            previous = self.in_available_actions
            self.in_available_actions = node.name == "available_actions"
            updated = self.generic_visit(node)
            self.in_available_actions = previous
            return updated

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
            previous = self.in_available_actions
            self.in_available_actions = node.name == "available_actions"
            updated = self.generic_visit(node)
            self.in_available_actions = previous
            return updated

        def visit_Compare(self, node: ast.Compare) -> ast.AST:
            node = self.generic_visit(node)
            operands = [node.left, *node.comparators]
            for index, operand in enumerate(operands):
                peers = operands[:index] + operands[index + 1 :]
                if (
                    isinstance(operand, ast.Name)
                    and operand.id == action_name
                    and any(_integer_action_operand(peer) for peer in peers)
                ):
                    operands[index] = ast.Subscript(
                        value=ast.Name(id=action_name, ctx=ast.Load()),
                        slice=ast.Constant(value="action"),
                        ctx=ast.Load(),
                    )
            node.left = operands[0]
            node.comparators = operands[1:]
            return node

        def visit_Return(self, node: ast.Return) -> ast.AST:
            node = self.generic_visit(node)
            if self.in_available_actions and isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                node.value.elts = [
                    ast.Dict(
                        keys=[ast.Constant(value="action")],
                        values=[ast.Constant(value=int(item.value))],
                    )
                    if isinstance(item, ast.Constant)
                    and isinstance(item.value, int)
                    and not isinstance(item.value, bool)
                    else item
                    for item in node.value.elts
                ]
            return node

    normalized = ProtocolNormalizer().visit(tree)
    ast.fix_missing_locations(normalized)
    return ast.unparse(normalized)


def _integer_action_operand(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, int) and not isinstance(node.value, bool)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return bool(node.elts) and all(_integer_action_operand(item) for item in node.elts)
    return False


def _protocol_v2_error(tree: ast.Module) -> str:
    step = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "step"
        ),
        None,
    )
    if step is None or len(step.args.args) < 2:
        return "protocol-v2 step must accept state and ModelAction"
    action_name = step.args.args[1].arg
    for node in ast.walk(step):
        if not isinstance(node, ast.Compare):
            continue
        operands = [node.left, *node.comparators]
        for index, operand in enumerate(operands):
            if (
                isinstance(operand, ast.Name)
                and operand.id == action_name
                and any(
                    _integer_action_operand(peer)
                    for peer_index, peer in enumerate(operands)
                    if peer_index != index
                )
            ):
                return "protocol-v2 step compares the ModelAction dictionary to an integer"
    available = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "available_actions"
        ),
        None,
    )
    if available is not None:
        for node in ast.walk(available):
            if isinstance(node, ast.Return) and isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                if any(_integer_action_operand(item) for item in node.value.elts):
                    return "protocol-v2 available_actions returns integers instead of ModelAction dictionaries"
    return ""


class AutonomousModelWorker:
    """Persistent isolated subprocess with one request in flight at a time."""

    def __init__(
        self,
        workspace: str | Path | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        self._owned_workspace = workspace is None
        self.workspace = Path(workspace or tempfile.mkdtemp(prefix="ouro-arc-model-"))
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.timeout_seconds = float(
            timeout_seconds
            or os.getenv("OURO_ARC_WORLD_MODEL_WORKER_TIMEOUT_SECONDS", "10")
        )
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self.disabled_reason = ""

    @property
    def disabled(self) -> bool:
        return bool(self.disabled_reason)

    def _start(self) -> None:
        if self.disabled:
            raise RuntimeError(self.disabled_reason)
        if self._process is not None and self._process.poll() is None:
            return
        worker = Path(__file__).with_name("autonomous_worker.py")
        env = {
            "PATH": os.getenv("PATH", ""),
            "PYTHONHASHSEED": "0",
            "OURO_ARC_MODEL_WORKSPACE": str(self.workspace.resolve()),
            "OURO_ARC_WORLD_MODEL_MEMORY_MB": os.getenv("OURO_ARC_WORLD_MODEL_MEMORY_MB", "512"),
            "OURO_ARC_WORLD_MODEL_MAX_OUTPUT_BYTES": os.getenv("OURO_ARC_WORLD_MODEL_MAX_OUTPUT_BYTES", "1048576"),
        }
        self._process = subprocess.Popen(
            [sys.executable, "-E", "-s", "-S", str(worker)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=self.workspace,
            env=env,
        )

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._start()
            assert self._process is not None
            assert self._process.stdin is not None
            assert self._process.stdout is not None
            request = dict(payload)
            request["request_timeout_seconds"] = max(1, int(self.timeout_seconds))
            try:
                self._process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                self._process.stdin.flush()
                selector = selectors.DefaultSelector()
                selector.register(self._process.stdout, selectors.EVENT_READ)
                ready = selector.select(self.timeout_seconds + 1.0)
                selector.close()
                if not ready:
                    self._disable("worker wall-time limit exceeded")
                    raise TimeoutError(self.disabled_reason)
                line = self._process.stdout.readline()
                if not line:
                    detail = ""
                    if self._process.stderr is not None:
                        detail = self._process.stderr.read()[-1000:]
                    self._disable(f"worker exited unexpectedly: {detail}")
                    raise RuntimeError(self.disabled_reason)
                response = json.loads(line)
            except (BrokenPipeError, json.JSONDecodeError, OSError) as exc:
                self._disable(f"worker transport failed: {exc!r}")
                raise RuntimeError(self.disabled_reason) from exc
            if not response.get("ok"):
                error = str(response.get("error", "WorkerError"))
                detail = str(response.get("detail", ""))
                if error in {"TimeoutError", "MemoryError", "OutputLimit", "PermissionError"}:
                    self._disable(f"{error}: {detail}")
                raise RuntimeError(f"{error}: {detail}")
            result = response.get("result", {})
            return result if isinstance(result, dict) else {"value": result}

    def _disable(self, reason: str) -> None:
        self.disabled_reason = reason
        self.close()

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        if self._owned_workspace and self.workspace.exists():
            shutil.rmtree(self.workspace, ignore_errors=True)

    def __enter__(self) -> "AutonomousModelWorker":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


class AutonomousWorldModel:
    """Owns timeline, model versions, certification, probes, and planning."""

    def __init__(
        self,
        game_id: str = "unknown",
        beam_size: int | None = None,
        worker: AutonomousModelWorker | None = None,
    ) -> None:
        self.game_id = game_id
        self.beam_size = max(1, int(beam_size or os.getenv("OURO_ARC_WORLD_MODEL_BEAM", "4")))
        if worker is None:
            base = os.getenv("OURO_ARC_GENERATED_MODEL_DIR", "").strip()
            workspace = None
            if base:
                safe_game = "".join(character if character.isalnum() or character in "-_" else "_" for character in game_id)
                workspace = Path(base) / safe_game
            worker = AutonomousModelWorker(workspace=workspace)
        self.worker = worker
        self.timeline: list[CausalTransitionRecord] = []
        self.candidates: list[ModelCandidate] = []
        self.revisions = 0
        self.rejections: dict[str, int] = {}
        self.last_mismatch: ReplayFailure | None = None
        self.plan_expansions = 0
        self.plan_aborts = 0
        self.episode = 0
        self.stalled_revisions = 0
        self.best_coverage_seen = 0.0
        self.helpers_source = ""

    def set_helpers_source(self, source: str) -> None:
        self.helpers_source = source

    def observe(
        self,
        *,
        episode: int | None = None,
        level: int,
        before_grid: list[list[int]],
        action: ActionSpec,
        after_grid: list[list[int]],
        before_state: str,
        after_state: str,
        goal: bool,
    ) -> CausalTransitionRecord:
        record = CausalTransitionRecord(
            index=len(self.timeline),
            episode=self.episode if episode is None else int(episode),
            level=level,
            before_grid=[list(row) for row in before_grid],
            action=action.to_model_json(),
            after_grid=[list(row) for row in after_grid],
            before_state=before_state,
            after_state=after_state,
            goal=goal,
        )
        self.timeline.append(record)
        self._append_jsonl("timeline.jsonl", record.to_json())
        return record

    def certify(self, source: str) -> tuple[SourceValidation, CertificationResult]:
        validation = validate_generated_source(source)
        if not validation.valid:
            return validation, CertificationResult(
                0,
                len(self.timeline),
                (ReplayFailure(-1, "source", validation.reason),),
            )
        try:
            raw = self.worker.request(
                {
                    "operation": "certify",
                    "source": source,
                    "helpers_source": self.helpers_source,
                    "records": [record.to_json() for record in self.timeline],
                }
            )
        except Exception as exc:
            return validation, CertificationResult(
                0,
                len(self.timeline),
                (ReplayFailure(-1, "worker", repr(exc)),),
            )
        failures = tuple(
            ReplayFailure(
                int(item.get("index", -1)),
                str(item.get("kind", "unknown")),
                str(item.get("detail", "")),
                int(item.get("episode", 0)),
                {
                    str(key): value
                    for key, value in item.items()
                    if key not in {"index", "kind", "detail", "episode"}
                },
            )
            for item in raw.get("failures", [])
            if isinstance(item, dict)
        )
        return validation, CertificationResult(
            int(raw.get("passed", 0)),
            int(raw.get("total", len(self.timeline))),
            failures,
            tuple(int(item) for item in raw.get("passed_indexes", [])),
            raw.get("final_state"),
            str(raw["final_state_hash"]) if raw.get("final_state_hash") is not None else None,
            int(raw["final_episode"]) if raw.get("final_episode") is not None else None,
        )

    def add_candidate(
        self,
        source: str,
        *,
        critic_approved: bool = False,
        critic_verdict: str | None = None,
        critic_issues: Iterable[str] = (),
        counterexample_indexes: Iterable[int] = (),
        source_parent: str | None = None,
        notes: str = "",
    ) -> ModelCandidate | None:
        validation, certification = self.certify(source)
        if not validation.valid:
            self._reject(validation.reason)
            self.revisions += 1
            self.stalled_revisions += 1
            self.last_mismatch = certification.failures[0]
            return None
        version = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
        existing = next((item for item in self.candidates if item.version == version), None)
        if existing is not None:
            self.revisions += 1
            self.stalled_revisions += 1
            return existing
        passed_indexes = set(certification.passed_indexes)
        levels = {
            record.level
            for record in self.timeline
            if record.index in passed_indexes
        }
        verdict = critic_verdict or ("accept" if critic_approved else "pending")
        candidate = ModelCandidate(
            version=version,
            source=source,
            certification=certification,
            ast_nodes=validation.ast_nodes,
            exception_count=_exception_count(source),
            cross_level_coverage=len(levels),
            critic_approved=critic_approved,
            notes=notes[:1000],
            critic_verdict=verdict,
            critic_issues=tuple(str(item)[:500] for item in critic_issues),
            counterexample_indexes=tuple(int(item) for item in counterexample_indexes),
            source_parent=source_parent,
            revision=self.revisions + 1,
        )
        self.candidates.append(candidate)
        self.candidates.sort(key=lambda item: item.rank_key)
        self.candidates = self.candidates[: self.beam_size]
        self.revisions += 1
        if certification.coverage > self.best_coverage_seen:
            self.best_coverage_seen = certification.coverage
            self.stalled_revisions = 0
        else:
            self.stalled_revisions += 1
        self._persist_candidate(candidate)
        self._persist_replay(candidate)
        if certification.failures:
            self.last_mismatch = certification.failures[0]
        elif certification.certified:
            self.last_mismatch = None
        return candidate

    def update_critic(
        self,
        version: str,
        *,
        verdict: str,
        issues: Iterable[str] = (),
        counterexample_indexes: Iterable[int] = (),
    ) -> ModelCandidate | None:
        for index, candidate in enumerate(self.candidates):
            if candidate.version != version:
                continue
            updated = replace(
                candidate,
                critic_approved=verdict == "accept",
                critic_verdict=verdict,
                critic_issues=tuple(str(item)[:500] for item in issues),
                counterexample_indexes=tuple(int(item) for item in counterexample_indexes),
            )
            self.candidates[index] = updated
            self.candidates.sort(key=lambda item: item.rank_key)
            self._persist_candidate(updated)
            return updated
        return None

    def record_deliberation(self, payload: dict[str, Any]) -> None:
        self._append_jsonl("deliberations.jsonl", payload)

    def record_plan_mismatch(self, payload: dict[str, Any]) -> None:
        self._append_jsonl("plan_mismatches.jsonl", payload)

    def recertify_all(self) -> bool:
        """Replay every candidate after a new real transition.

        Returns true when the previously certified leader stops matching.
        """

        previous = self.best_certified.version if self.best_certified else None
        refreshed: list[ModelCandidate] = []
        for candidate in self.candidates:
            validation, certification = self.certify(candidate.source)
            passed_indexes = set(certification.passed_indexes)
            levels = {
                record.level
                for record in self.timeline
                if record.index in passed_indexes
            }
            refreshed.append(
                ModelCandidate(
                    version=candidate.version,
                    source=candidate.source,
                    certification=certification,
                    ast_nodes=validation.ast_nodes or candidate.ast_nodes,
                    exception_count=candidate.exception_count,
                    cross_level_coverage=len(levels),
                    critic_approved=candidate.critic_approved,
                    notes=candidate.notes,
                    critic_verdict=candidate.critic_verdict,
                    critic_issues=candidate.critic_issues,
                    counterexample_indexes=candidate.counterexample_indexes,
                    source_parent=candidate.source_parent,
                    revision=candidate.revision,
                    protocol_version=candidate.protocol_version,
                )
            )
            if certification.failures:
                self.last_mismatch = certification.failures[0]
        refreshed.sort(key=lambda item: item.rank_key)
        self.candidates = refreshed[: self.beam_size]
        leader = self.best
        if leader is not None:
            self.last_mismatch = (
                leader.certification.failures[0]
                if leader.certification.failures
                else None
            )
        current = self.best_certified.version if self.best_certified else None
        return previous is not None and current != previous

    @property
    def best(self) -> ModelCandidate | None:
        return self.candidates[0] if self.candidates else None

    @property
    def best_certified(self) -> ModelCandidate | None:
        return next((item for item in self.candidates if item.certified), None)

    def plan(self, grid: list[list[int]], algorithm: str = "bfs") -> AutonomousPlan | None:
        candidate = self.best_certified
        if candidate is None:
            return None
        try:
            request: dict[str, Any] = {
                    "operation": "plan",
                    "source": candidate.source,
                    "helpers_source": self.helpers_source,
                    "algorithm": algorithm,
                    "max_states": int(os.getenv("OURO_ARC_WORLD_MODEL_SEARCH_STATES", "10000")),
                    "max_depth": int(os.getenv("OURO_ARC_WORLD_MODEL_SEARCH_DEPTH", "64")),
                }
            if candidate.certification.final_state is not None:
                request["state"] = candidate.certification.final_state
            else:
                request["grid"] = grid
            raw = self.worker.request(request)
        except Exception as exc:
            self._reject(f"plan:{exc!r}")
            return None
        self.plan_expansions += int(raw.get("expanded", 0))
        if not raw.get("found"):
            return None
        actions: list[ActionSpec] = []
        try:
            for item in raw.get("actions", []):
                spec = ActionSpec.from_json(item)
                actions.append(ActionSpec(spec.action, spec.x, spec.y, "certified autonomous plan", "autonomous-plan"))
        except (TypeError, ValueError):
            self._reject("plan:invalid-action")
            return None
        grids = tuple(raw.get("predicted_grids", []))
        hashes = tuple(str(item) for item in raw.get("state_hashes", []))
        states = tuple(raw.get("predicted_states", []))
        if not actions or len(actions) != len(hashes) or len(actions) != len(grids) or len(actions) != len(states):
            self._reject("plan:invalid-prediction-shape")
            return None
        objective = str(raw.get("objective", "goal"))
        if objective == "progress":
            actions = actions[:1]
            hashes = hashes[:1]
            grids = grids[:1]
            states = states[:1]
        return AutonomousPlan(
            tuple(actions),
            hashes,
            grids,
            states,
            int(raw.get("expanded", 0)),
            candidate.version,
            objective,
        )

    def predict_from_state(
        self,
        model_version: str,
        state: Any,
        action: ActionSpec,
    ) -> dict[str, Any] | None:
        candidate = next((item for item in self.candidates if item.version == model_version), None)
        if candidate is None:
            return None
        try:
            return self.worker.request(
                {
                    "operation": "predict",
                    "source": candidate.source,
                    "helpers_source": self.helpers_source,
                    "state": state,
                    "action": action.to_model_json(),
                }
            )
        except Exception as exc:
            self._reject(f"predict:{exc!r}")
            return None

    def discriminating_probe(
        self,
        grid: list[list[int]],
        actions: Iterable[ActionSpec],
    ) -> DiscriminatingProbe | None:
        candidates = [item for item in self.candidates if item.certification.passed > 0]
        if len(candidates) < 2:
            return None
        best: DiscriminatingProbe | None = None
        for action in actions:
            predictions: list[tuple[str, str]] = []
            for candidate in candidates:
                try:
                    raw = self.worker.request(
                        {
                            "operation": "predict",
                            "source": candidate.source,
                            "helpers_source": self.helpers_source,
                            "grid": grid,
                            "action": action.to_model_json(),
                        }
                    )
                    signature = hashlib.sha256(
                        json.dumps({"grid": raw.get("grid"), "goal": raw.get("goal")}, sort_keys=True).encode("utf-8")
                    ).hexdigest()[:16]
                    predictions.append((candidate.version, signature))
                except Exception:
                    predictions.append((candidate.version, "error"))
            disagreement = len({signature for _version, signature in predictions})
            probe = DiscriminatingProbe(action, disagreement, tuple(predictions))
            if disagreement > 1 and (
                best is None
                or (-probe.disagreement, probe.action.key) < (-best.disagreement, best.action.key)
            ):
                best = probe
        return best

    def summary(self) -> dict[str, Any]:
        best = self.best
        return {
            "enabled": True,
            "game_id": self.game_id,
            "protocol_version": MODEL_PROTOCOL_VERSION,
            "timeline_records": len(self.timeline),
            "episodes": len({record.episode for record in self.timeline}),
            "candidate_count": len(self.candidates),
            "best_version": best.version if best else None,
            "best_coverage": best.certification.coverage if best else 0.0,
            "best_critic_verdict": best.critic_verdict if best else None,
            "best_source_parent": best.source_parent if best else None,
            "best_final_state_hash": best.certification.final_state_hash if best else None,
            "certified": bool(self.best_certified),
            "revisions": self.revisions,
            "stalled_revisions": self.stalled_revisions,
            "rejections": dict(sorted(self.rejections.items())),
            "last_mismatch": (
                {
                    "index": self.last_mismatch.index,
                    "episode": self.last_mismatch.episode,
                    "kind": self.last_mismatch.kind,
                    "detail": self.last_mismatch.detail,
                    "evidence": self.last_mismatch.evidence,
                }
                if self.last_mismatch
                else None
            ),
            "plan_expansions": self.plan_expansions,
            "plan_aborts": self.plan_aborts,
            "worker_disabled": self.worker.disabled,
            "worker_failure": self.worker.disabled_reason,
        }

    def close(self) -> None:
        self.worker.close()

    def _reject(self, reason: str) -> None:
        key = reason[:120]
        self.rejections[key] = self.rejections.get(key, 0) + 1

    def _persist_candidate(self, candidate: ModelCandidate) -> None:
        try:
            artifacts = self.worker.workspace / ".trusted"
            models = artifacts / "models"
            models.mkdir(parents=True, exist_ok=True)
            (models / f"world_model.{candidate.version}.py").write_text(
                candidate.source,
                encoding="utf-8",
            )
            metadata = {
                "version": candidate.version,
                "protocol_version": candidate.protocol_version,
                "revision": candidate.revision,
                "source_parent": candidate.source_parent,
                "certified": candidate.certified,
                "critic_approved": candidate.critic_approved,
                "critic_verdict": candidate.critic_verdict,
                "critic_issues": list(candidate.critic_issues),
                "counterexample_indexes": list(candidate.counterexample_indexes),
                "coverage": candidate.certification.coverage,
                "final_state_hash": candidate.certification.final_state_hash,
                "ast_nodes": candidate.ast_nodes,
                "exception_count": candidate.exception_count,
                "cross_level_coverage": candidate.cross_level_coverage,
            }
            (models / f"world_model.{candidate.version}.json").write_text(
                json.dumps(metadata, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            if candidate.certified:
                (artifacts / "world_model.py").write_text(candidate.source, encoding="utf-8")
        except OSError:
            pass

    def _persist_replay(self, candidate: ModelCandidate) -> None:
        try:
            artifacts = self.worker.workspace / ".trusted" / "replay_reports"
            artifacts.mkdir(parents=True, exist_ok=True)
            payload = {
                "protocol_version": MODEL_PROTOCOL_VERSION,
                "version": candidate.version,
                "passed": candidate.certification.passed,
                "total": candidate.certification.total,
                "coverage": candidate.certification.coverage,
                "passed_indexes": list(candidate.certification.passed_indexes),
                "final_state_hash": candidate.certification.final_state_hash,
                "failures": [
                    {
                        "index": failure.index,
                        "episode": failure.episode,
                        "kind": failure.kind,
                        "detail": failure.detail,
                        "evidence": failure.evidence,
                    }
                    for failure in candidate.certification.failures
                ],
            }
            (artifacts / f"replay.{candidate.version}.json").write_text(
                json.dumps(payload, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass

    def _append_jsonl(self, name: str, payload: dict[str, Any]) -> None:
        try:
            artifacts = self.worker.workspace / ".trusted"
            artifacts.mkdir(parents=True, exist_ok=True)
            with (artifacts / name).open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
        except OSError:
            pass


def _exception_count(source: str) -> int:
    try:
        return sum(
            1
            for node in ast.walk(ast.parse(source))
            if isinstance(node, (ast.If, ast.IfExp, ast.Try, ast.Match))
        )
    except SyntaxError:
        return 10**9
