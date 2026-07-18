"""JSON-lines worker for executing generated world models out of process."""

from __future__ import annotations

import ast
import builtins
import hashlib
import heapq
import json
import os
import resource
import signal
import sys
import traceback
from collections import deque
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import mechanics as _mechanics

REQUIRED_FUNCTIONS = (
    "parse_observation",
    "available_actions",
    "step",
    "render",
    "is_goal",
    "canonicalize",
)
SAFE_IMPORTS = {
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
SAFE_MODULE_EXPORTS = {
    "collections": {"Counter", "defaultdict", "deque", "namedtuple"},
    "copy": {"copy", "deepcopy"},
    "dataclasses": {"dataclass", "field", "replace"},
    "enum": {"Enum", "IntEnum", "auto"},
    "functools": {"cache", "lru_cache", "partial", "reduce"},
    "heapq": {"heapify", "heappop", "heappush", "nsmallest", "nlargest"},
    "itertools": {"chain", "combinations", "count", "permutations", "product", "repeat"},
    "math": {"ceil", "comb", "dist", "floor", "gcd", "inf", "isclose", "lcm", "sqrt"},
    "operator": {"add", "and_", "eq", "itemgetter", "mul", "or_", "sub"},
    "statistics": {"mean", "median", "mode"},
    "typing": {"Any", "Callable", "Iterable", "Sequence"},
}


def _workspace() -> Path:
    return Path(os.environ["OURO_ARC_MODEL_WORKSPACE"]).resolve()


def _inside_workspace(value: Any) -> bool:
    try:
        path = Path(os.fspath(value))
        if not path.is_absolute():
            path = _workspace() / path
        path = path.resolve(strict=False)
        trusted = _workspace() / ".trusted"
        if path == trusted or trusted in path.parents:
            return False
        return path == _workspace() or _workspace() in path.parents
    except (OSError, TypeError, ValueError):
        return False


_real_open = builtins.open
_real_import = builtins.__import__


def _safe_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
    if not _inside_workspace(file):
        raise PermissionError("generated model file access outside private workspace")
    return _real_open(file, mode, *args, **kwargs)


def _safe_import(name: str, *args: Any, **kwargs: Any) -> Any:
    root = name.split(".", 1)[0]
    if root not in SAFE_IMPORTS:
        raise ImportError(f"generated model import blocked: {name}")
    module = _real_import(root, *args, **kwargs)
    return SimpleNamespace(
        **{
            item: getattr(module, item)
            for item in SAFE_MODULE_EXPORTS[root]
            if hasattr(module, item)
        }
    )


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if event in {"socket.__new__", "socket.connect", "subprocess.Popen", "os.system", "os.posix_spawn", "ctypes.dlopen"}:
        raise PermissionError(f"generated model operation blocked: {event}")
    if event == "open" and args and not _inside_workspace(args[0]):
        try:
            path = Path(os.fspath(args[0])).resolve(strict=False)
            runtime_roots = (Path(sys.prefix).resolve(), Path(__file__).resolve().parent)
            if any(path == root or root in path.parents for root in runtime_roots):
                return
        except (OSError, TypeError, ValueError):
            pass
        raise PermissionError("generated model file access outside private workspace")


def _limits() -> None:
    memory_mb = max(64, int(os.getenv("OURO_ARC_WORLD_MODEL_MEMORY_MB", "512")))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024,) * 2)
    except (OSError, ValueError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_DATA, (memory_mb * 1024 * 1024,) * 2)
    except (AttributeError, OSError, ValueError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (OSError, ValueError):
        pass


def _timeout_handler(_signum: int, _frame: Any) -> None:
    raise TimeoutError("generated model request timed out")


def _safe_builtins() -> dict[str, Any]:
    allowed = {
        "abs", "all", "any", "bool", "bytes", "callable", "chr", "dict", "divmod",
        "enumerate", "filter", "float", "frozenset", "hash",
        "hex", "int", "isinstance", "issubclass", "iter", "len", "list", "map",
        "max", "min", "next", "object", "oct", "ord", "pow", "property", "range",
        "repr", "reversed", "round", "set", "slice", "sorted", "str",
        "sum", "super", "tuple", "type", "zip", "Exception", "ValueError", "TypeError",
        "KeyError", "IndexError", "RuntimeError", "AssertionError", "StopIteration",
    }
    result = {name: getattr(builtins, name) for name in allowed}
    result["open"] = _safe_open
    result["__import__"] = _safe_import
    return result


def _namespace(
    source: str,
    *,
    require_model: bool = True,
    helpers_source: str = "",
) -> dict[str, Any]:
    tree = ast.parse(source, mode="exec")
    code = compile(tree, "<generated-world-model>", "exec")
    mechanics = SimpleNamespace(
        **{name: getattr(_mechanics, name) for name in _mechanics.PUBLIC_NAMES}
    )
    namespace: dict[str, Any] = {
        "__builtins__": _safe_builtins(),
        "__name__": "generated_world_model",
        "mechanics": mechanics,
    }
    helper_exports: dict[str, Any] = {}
    if helpers_source.strip():
        helper_tree = ast.parse(helpers_source, mode="exec")
        helper_code = compile(helper_tree, "<promoted-world-model-helpers>", "exec")
        helper_namespace = dict(namespace)
        exec(helper_code, helper_namespace, helper_namespace)
        helper_exports = {
            name: value
            for name, value in helper_namespace.items()
            if not name.startswith("_") and callable(value)
        }
    namespace["helpers"] = SimpleNamespace(**helper_exports)
    exec(code, namespace, namespace)
    missing = [name for name in REQUIRED_FUNCTIONS if not callable(namespace.get(name))]
    if require_model and missing:
        raise ValueError(f"missing required functions: {', '.join(missing)}")
    return namespace


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset, deque)):
        return [_jsonable(item) for item in value]
    return repr(value)


def _action_json(value: Any) -> dict[str, Any]:
    if isinstance(value, int):
        return {"action": value}
    if isinstance(value, dict) and "action" in value:
        result = {"action": int(value["action"])}
        for key in ("x", "y"):
            if value.get(key) is not None:
                result[key] = int(value[key])
        return result
    raise ValueError(f"invalid modeled action: {value!r}")


def _canonical(namespace: dict[str, Any], state: Any) -> str:
    value = _jsonable(namespace["canonicalize"](state))
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _grid_hash(grid: Any) -> str:
    return hashlib.sha256(
        json.dumps(_jsonable(grid), sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]


def _grid_mismatch(expected: Any, predicted: Any) -> dict[str, Any]:
    if not isinstance(expected, list) or not isinstance(predicted, list):
        return {
            "changed_count": -1,
            "bounds": None,
            "expected_hash": _grid_hash(expected),
            "predicted_hash": _grid_hash(predicted),
        }
    changed: list[tuple[int, int]] = []
    height = max(len(expected), len(predicted))
    for y in range(height):
        expected_row = expected[y] if y < len(expected) and isinstance(expected[y], list) else []
        predicted_row = predicted[y] if y < len(predicted) and isinstance(predicted[y], list) else []
        for x in range(max(len(expected_row), len(predicted_row))):
            left = expected_row[x] if x < len(expected_row) else None
            right = predicted_row[x] if x < len(predicted_row) else None
            if left != right:
                changed.append((x, y))
    payload: dict[str, Any] = {
        "changed_count": len(changed),
        "expected_hash": _grid_hash(expected),
        "predicted_hash": _grid_hash(predicted),
    }
    if not changed:
        payload["bounds"] = None
        return payload
    min_x = min(x for x, _y in changed)
    max_x = max(x for x, _y in changed)
    min_y = min(y for _x, y in changed)
    max_y = max(y for _x, y in changed)
    payload["bounds"] = [min_x, min_y, max_x, max_y]
    crop_max = 16
    crop_x1 = min(max_x, min_x + crop_max - 1)
    crop_y1 = min(max_y, min_y + crop_max - 1)

    def crop(grid: Any) -> list[list[Any]]:
        result: list[list[Any]] = []
        for y in range(min_y, crop_y1 + 1):
            row = grid[y] if isinstance(grid, list) and y < len(grid) and isinstance(grid[y], list) else []
            result.append([row[x] if x < len(row) else None for x in range(min_x, crop_x1 + 1)])
        return result

    payload["crop_bounds"] = [min_x, min_y, crop_x1, crop_y1]
    payload["expected_crop"] = crop(expected)
    payload["predicted_crop"] = crop(predicted)
    return payload


def _certify(namespace: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    passed = 0
    passed_indexes: list[int] = []
    final_state: Any = None
    final_hash: str | None = None
    final_episode: int | None = None
    episodes: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        episodes.setdefault(int(record.get("episode", 0)), []).append(record)

    for episode in sorted(episodes):
        episode_records = sorted(episodes[episode], key=lambda item: int(item.get("index", 0)))
        first = episode_records[0]
        try:
            state = namespace["parse_observation"](deepcopy(first["before_grid"]), {})
        except Exception as exc:
            failures.append({
                "index": int(first.get("index", -1)),
                "episode": episode,
                "kind": "perception",
                "detail": repr(exc),
            })
            continue
        try:
            initial_render = _jsonable(namespace["render"](deepcopy(state)))
        except Exception as exc:
            failures.append({
                "index": int(first.get("index", -1)),
                "episode": episode,
                "kind": "rendering",
                "detail": f"initial round-trip failed: {exc!r}",
            })
            continue
        if initial_render != first["before_grid"]:
            failure = {
                "index": int(first.get("index", -1)),
                "episode": episode,
                "kind": "perception_rendering",
                "detail": "parse/render does not reproduce the episode's initial observation",
            }
            failure.update(_grid_mismatch(first["before_grid"], initial_render))
            failures.append(failure)
            continue
        for record in episode_records:
            record_index = int(record.get("index", -1))
            try:
                predicted = namespace["step"](
                    deepcopy(state),
                    _action_json(deepcopy(record["action"])),
                )
            except Exception as exc:
                failures.append({
                    "index": record_index,
                    "episode": episode,
                    "kind": "transition",
                    "detail": repr(exc),
                })
                break
            try:
                rendered = _jsonable(namespace["render"](deepcopy(predicted)))
            except Exception as exc:
                failures.append({
                    "index": record_index,
                    "episode": episode,
                    "kind": "rendering",
                    "detail": repr(exc),
                })
                break
            if rendered != record["after_grid"]:
                failure = {
                    "index": record_index,
                    "episode": episode,
                    "kind": "transition_or_latent",
                    "detail": "predicted state does not render the observed next grid",
                    "expected_state": str(record.get("after_state", "")),
                }
                failure.update(_grid_mismatch(record["after_grid"], rendered))
                failures.append(failure)
                break
            try:
                predicted_goal = bool(namespace["is_goal"](deepcopy(predicted)))
            except Exception as exc:
                failures.append({
                    "index": record_index,
                    "episode": episode,
                    "kind": "goal",
                    "detail": repr(exc),
                })
                break
            expected_goal = bool(record.get("goal", False))
            if predicted_goal != expected_goal:
                failures.append({
                    "index": record_index,
                    "episode": episode,
                    "kind": "goal",
                    "detail": f"predicted={predicted_goal} expected={expected_goal}",
                    "expected_goal": expected_goal,
                    "predicted_goal": predicted_goal,
                })
                break
            state = predicted
            passed += 1
            passed_indexes.append(record_index)
        else:
            final_state = _jsonable(state)
            final_hash = _canonical(namespace, state)
            final_episode = episode

    certified = passed == len(records) and not failures
    return {
        "passed": passed,
        "total": len(records),
        "certified": certified,
        "failures": failures,
        "passed_indexes": passed_indexes,
        "final_state": final_state if certified else None,
        "final_state_hash": final_hash if certified else None,
        "final_episode": final_episode if certified else None,
    }


def _plan(namespace: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if "state" in request:
        state = deepcopy(request["state"])
    else:
        state = namespace["parse_observation"](deepcopy(request["grid"]), deepcopy(request.get("memory", {})))
    algorithm = str(request.get("algorithm", "bfs"))
    max_states = max(1, int(request.get("max_states", 10000)))
    max_depth = max(1, int(request.get("max_depth", 64)))
    start_key = _canonical(namespace, state)
    parent: dict[str, tuple[str | None, dict[str, Any] | None, str]] = {
        start_key: (None, None, start_key)
    }
    states: dict[str, Any] = {start_key: state}
    if algorithm == "astar":
        frontier: Any = [(0.0, 0, start_key)]
    else:
        frontier = deque([(0, start_key)])
    goal_key: str | None = None
    objective = "goal"
    progress = namespace.get("progress_score")
    start_progress = float(progress(deepcopy(state))) if callable(progress) else 0.0
    best_progress = start_progress
    best_progress_key: str | None = None
    while frontier and len(parent) <= max_states:
        if algorithm == "astar":
            _priority, depth, key = heapq.heappop(frontier)
        elif algorithm == "backtracking":
            depth, key = frontier.pop()
        else:
            depth, key = frontier.popleft()
        current = states[key]
        if bool(namespace["is_goal"](deepcopy(current))):
            goal_key = key
            break
        if depth >= max_depth:
            continue
        raw_actions = namespace["available_actions"](deepcopy(current))
        actions = sorted((_action_json(item) for item in raw_actions), key=lambda item: json.dumps(item, sort_keys=True))
        for action in actions:
            predicted = namespace["step"](deepcopy(current), deepcopy(action))
            next_key = _canonical(namespace, predicted)
            if next_key in parent:
                continue
            parent[next_key] = (key, action, next_key)
            states[next_key] = predicted
            if callable(progress):
                candidate_progress = float(progress(deepcopy(predicted)))
                if candidate_progress > best_progress or (
                    candidate_progress == best_progress
                    and best_progress_key is not None
                    and next_key < best_progress_key
                ):
                    best_progress = candidate_progress
                    best_progress_key = next_key
            if algorithm == "astar":
                heuristic = namespace.get("heuristic")
                estimate = float(heuristic(predicted)) if callable(heuristic) else 0.0
                heapq.heappush(frontier, (depth + 1 + estimate, depth + 1, next_key))
            else:
                frontier.append((depth + 1, next_key))
    if goal_key is None and best_progress_key is not None and best_progress > start_progress:
        goal_key = best_progress_key
        objective = "progress"
    if goal_key is None:
        return {"found": False, "expanded": len(parent), "actions": [], "state_hashes": []}
    actions: list[dict[str, Any]] = []
    hashes: list[str] = []
    predicted_grids: list[Any] = []
    predicted_states: list[Any] = []
    cursor = goal_key
    while parent[cursor][0] is not None:
        previous, action, state_hash = parent[cursor]
        actions.append(action or {})
        hashes.append(state_hash)
        predicted_grids.append(_jsonable(namespace["render"](deepcopy(states[cursor]))))
        predicted_states.append(_jsonable(states[cursor]))
        cursor = str(previous)
    actions.reverse()
    hashes.reverse()
    predicted_grids.reverse()
    predicted_states.reverse()
    return {
        "found": True,
        "objective": objective,
        "expanded": len(parent),
        "actions": actions,
        "state_hashes": hashes,
        "predicted_grids": predicted_grids,
        "predicted_states": predicted_states,
    }


def _predict(namespace: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if "state" in request:
        state = deepcopy(request["state"])
    else:
        state = namespace["parse_observation"](deepcopy(request["grid"]), deepcopy(request.get("memory", {})))
    predicted = namespace["step"](state, _action_json(deepcopy(request["action"])))
    rendered = _jsonable(namespace["render"](deepcopy(predicted)))
    return {
        "grid": rendered,
        "goal": bool(namespace["is_goal"](deepcopy(predicted))),
        "state_hash": _canonical(namespace, predicted),
        "state": _jsonable(predicted),
    }


def _call(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    namespace = _namespace(
        str(request.get("source", "")),
        require_model=operation != "invoke",
        helpers_source=str(request.get("helpers_source", "")),
    )
    if operation == "validate":
        return {"valid": True}
    if operation == "certify":
        return _certify(namespace, list(request.get("records", [])))
    if operation == "plan":
        return _plan(namespace, request)
    if operation == "predict":
        return _predict(namespace, request)
    if operation == "invoke":
        function = str(request["function"])
        if not callable(namespace.get(function)):
            raise ValueError(f"unknown function: {function}")
        return {"value": _jsonable(namespace[function](*deepcopy(request.get("args", [])), **deepcopy(request.get("kwargs", {}))))}
    raise ValueError(f"unknown operation: {operation}")


def main() -> None:
    _workspace().mkdir(parents=True, exist_ok=True)
    os.chdir(_workspace())
    _limits()
    sys.addaudithook(_audit)
    signal.signal(signal.SIGALRM, _timeout_handler)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            timeout = max(1, int(request.get("request_timeout_seconds", 5)))
            signal.alarm(timeout)
            result = _call(request)
            response = {"ok": True, "result": result}
        except BaseException as exc:
            response = {
                "ok": False,
                "error": type(exc).__name__,
                "detail": str(exc)[:1000],
                "trace": traceback.format_exc(limit=3)[-2000:],
            }
        finally:
            signal.alarm(0)
        encoded = json.dumps(response, sort_keys=True, separators=(",", ":"))
        if len(encoded) > int(os.getenv("OURO_ARC_WORLD_MODEL_MAX_OUTPUT_BYTES", "1048576")):
            encoded = json.dumps({"ok": False, "error": "OutputLimit", "detail": "worker response too large"})
        print(encoded, flush=True)


if __name__ == "__main__":
    main()
