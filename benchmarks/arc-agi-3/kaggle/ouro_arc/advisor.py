from __future__ import annotations

import ast
import base64
import contextlib
import hashlib
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .actions import ActionSpec, filter_legal_actions
from .model_config import model_env, model_flag

DEFAULT_MODEL_CANDIDATES = (
    "/kaggle/input/models/kinwochan/qwen-3-5-4b/transformers/qwen-3-5-4b/1",
    "/kaggle/input/models/kinwochan/qwen-3-5-4b/transformers/qwen3-5-4b/1",
    "/kaggle/input/models/kinwochan/qwen-3-5-4b",
)

DEFAULT_OLLAMA_MODEL = "qwen3.5:4b-mlx"


@dataclass
class AdvisorPlan:
    mode: str
    actions: list[ActionSpec]
    hypothesis: str = ""
    confidence: float = 0.0
    ranked_hypotheses: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlanParseResult:
    plan: AdvisorPlan | None
    reason: str
    repaired: bool = False


class ModelAdvisor:
    """Fail-open multimodal reasoning advisor.

    Kaggle uses the official offline Qwen3.5-4B Transformers checkpoint. Local
    Ollama runs use the corresponding MLX quantization on Apple Silicon.

    Advisor problems must never abort a run: the agent scores 0.00 for every
    game if an exception escapes here during a Kaggle rerun (submission
    versions 7 and 8). Every failure path logs, returns a null result, and —
    for unrecoverable load problems — latches the advisor into a disabled
    state so the deterministic controller keeps playing. `require_model=True`
    (set for Kaggle reruns) only makes the startup check eager and the logging
    loud; it never raises.
    """

    _shared_load_lock = threading.RLock()
    _shared_generation_lock = threading.Lock()
    _shared_runtimes: dict[tuple[str, str], tuple[Any, Any, float]] = {}

    def __init__(
        self,
        model_path: str | None = None,
        require_model: bool = False,
        max_new_tokens: int = 256,
    ) -> None:
        self.model_path = model_path or os.getenv("OURO_ARC_MODEL_PATH")
        self.require_model = require_model
        self.max_new_tokens = max_new_tokens
        self.processor: Any | None = None
        self.model: Any | None = None
        self.failure_reason: str | None = None
        self.load_seconds = 0.0
        self.call_attempts = 0
        self.call_successes = 0
        self.call_latencies: list[float] = []
        self.empty_content_responses = 0
        self.rejection_counts: dict[str, int] = {}
        self.call_records: list[dict[str, Any]] = []
        self.last_call_status = "not_called"
        self.last_call_detail = ""
        self.last_call_repaired = False

    @classmethod
    def clear_shared_runtime_for_tests(cls) -> None:
        with cls._shared_load_lock:
            cls._shared_runtimes.clear()

    @property
    def backend(self) -> str:
        return model_env("BACKEND", "transformers").lower()

    @property
    def disabled(self) -> bool:
        if self.failure_reason is not None:
            return True
        return os.getenv("OURO_ARC_DISABLE_MODEL", "").lower() in {"1", "true", "yes"}

    def _fail(self, reason: str) -> None:
        self.failure_reason = reason
        print(f"[ouro-arc] model advisor disabled, continuing deterministically: {reason}")

    def resolve_model_path(self) -> Path | None:
        candidates = (
            [self.model_path] if self.model_path else list(DEFAULT_MODEL_CANDIDATES)
        )
        for candidate in candidates:
            if candidate and Path(candidate).exists():
                return Path(candidate)
        return None

    def ensure_available(self) -> Path | None:
        if self.disabled:
            return None
        resolved = self.resolve_model_path()
        if resolved is None and self.require_model:
            searched = ", ".join(
                [self.model_path or "", *DEFAULT_MODEL_CANDIDATES]
            ).strip(", ")
            self._fail(
                "model input not found. Set OURO_ARC_MODEL_PATH or attach it "
                f"under one of: {searched}"
            )
        return resolved

    def load(self) -> bool:
        if self.backend == "ollama":
            return not self.disabled
        if self.model is not None and self.processor is not None:
            return True
        model_path = self.ensure_available()
        if model_path is None:
            return False
        dtype_name = model_env("DTYPE", "bf16").strip().lower()
        cache_key = (str(model_path.resolve()), dtype_name)
        try:
            with self._shared_load_lock:
                cached = self._shared_runtimes.get(cache_key)
                if cached is not None:
                    self.processor, self.model, self.load_seconds = cached
                    return True

                import torch  # type: ignore
                from transformers import AutoProcessor  # type: ignore

                try:
                    from transformers import AutoModelForMultimodalLM  # type: ignore
                except ImportError:
                    try:
                        from transformers import AutoModelForImageTextToText as AutoModelForMultimodalLM  # type: ignore
                    except ImportError:
                        from transformers import AutoModelForCausalLM as AutoModelForMultimodalLM  # type: ignore

                require_cuda = model_flag("REQUIRE_CUDA")
                cuda_available = bool(torch.cuda.is_available())
                if require_cuda and not cuda_available:
                    raise RuntimeError("CUDA is required but torch.cuda.is_available() is false")
                dtype: Any = "auto"
                if dtype_name in {"bf16", "bfloat16"}:
                    dtype = torch.bfloat16
                elif dtype_name in {"fp16", "float16"}:
                    dtype = torch.float16
                elif dtype_name in {"fp32", "float32"}:
                    dtype = torch.float32

                load_started = time.monotonic()
                processor = AutoProcessor.from_pretrained(
                    str(model_path), local_files_only=True
                )
                model_config = None
                if model_flag("FP8_FIX_GATE_PROJ"):
                    from transformers import AutoConfig  # type: ignore

                    model_config = AutoConfig.from_pretrained(
                        str(model_path), local_files_only=True
                    )
                    _repair_qwen_fp8_skip_patterns(model_config)
                model_kwargs: dict[str, Any] = {
                    "local_files_only": True,
                    "dtype": dtype,
                    "low_cpu_mem_usage": True,
                    "attn_implementation": "sdpa",
                    "device_map": {"": "cuda:0"} if cuda_available else "auto",
                }
                if model_config is not None:
                    model_kwargs["config"] = model_config
                model = AutoModelForMultimodalLM.from_pretrained(
                    str(model_path),
                    **model_kwargs,
                )
                if hasattr(model, "eval"):
                    model.eval()
                unscaled_fp8 = _unscaled_fp8_linear_names(model)
                if model_flag("REQUIRE_SCALED_FP8") and unscaled_fp8:
                    preview = ", ".join(unscaled_fp8[:4])
                    raise RuntimeError(
                        "unscaled FP8 linear modules remain after load: "
                        f"count={len(unscaled_fp8)} examples={preview}"
                    )
                load_seconds = time.monotonic() - load_started
                self.processor = processor
                self.model = model
                self.load_seconds = load_seconds
                self._shared_runtimes[cache_key] = (processor, model, load_seconds)
        except Exception as exc:
            # Retrying a broken model load on every advise call would burn the
            # wall-clock budget, so latch the advisor off permanently.
            self.processor = None
            self.model = None
            self._fail(f"model load failed: {exc!r}")
            return False
        return True

    def advise(
        self,
        prompt: str,
        available_actions: set[int],
        image: Any | None = None,
    ) -> AdvisorPlan | None:
        self.call_attempts += 1
        started = time.monotonic()
        self.last_call_status = "pending"
        self.last_call_detail = ""
        self.last_call_repaired = False
        candidate_ids = _ordered_hypothesis_ids(prompt)
        try:
            if self.backend == "ollama":
                plan = self._advise_ollama(prompt, available_actions, image=image)
            else:
                plan = self._advise_transformers(prompt, available_actions, image=image)
        finally:
            latency = time.monotonic() - started
            self.call_latencies.append(latency)
        if plan is not None:
            self.call_successes += 1
            if self.last_call_status == "pending":
                self._set_call_status("success")
        elif self.last_call_status == "pending":
            self._set_call_status("unknown_failure")
        self.call_records.append(
            {
                "attempt": self.call_attempts,
                "status": self.last_call_status,
                "detail": self.last_call_detail,
                "repaired": self.last_call_repaired,
                "candidate_hypothesis_ids": candidate_ids,
                "latency_seconds": round(latency, 3),
            }
        )
        return plan

    def complete_json(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        image: Any | None = None,
        system_prompt: str = "Return only one strict JSON object. Do not use markdown.",
        purpose: str = "world-model",
        max_new_tokens: int | None = None,
    ) -> dict[str, Any] | None:
        """Run a model-neutral structured completion for causal model authoring."""

        self.call_attempts += 1
        started = time.monotonic()
        self.last_call_status = "pending"
        self.last_call_detail = ""
        self.last_call_repaired = False
        transformers_prompt = (
            prompt
            + "\n\nRequired JSON Schema:\n"
            + json.dumps(schema, sort_keys=True, separators=(",", ":"))
        )
        try:
            if self.backend == "ollama":
                result = self._complete_ollama_json(
                    prompt,
                    schema,
                    image=image,
                    system_prompt=system_prompt,
                    max_new_tokens=max_new_tokens,
                )
            else:
                result = self._complete_transformers_json(
                    transformers_prompt,
                    schema=schema,
                    image=image,
                    system_prompt=system_prompt,
                    max_new_tokens=max_new_tokens,
                )
        finally:
            latency = time.monotonic() - started
            self.call_latencies.append(latency)
        if result is not None:
            self.call_successes += 1
            if self.last_call_status == "pending":
                self._set_call_status("success")
        elif self.last_call_status == "pending":
            self._set_call_status("unknown_failure")
        self.call_records.append(
            {
                "attempt": self.call_attempts,
                "purpose": purpose,
                "status": self.last_call_status,
                "detail": self.last_call_detail,
                "repaired": self.last_call_repaired,
                "candidate_hypothesis_ids": [],
                "latency_seconds": round(latency, 3),
            }
        )
        return result

    def _complete_ollama_json(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        image: Any | None,
        system_prompt: str,
        max_new_tokens: int | None,
    ) -> dict[str, Any] | None:
        if not self.load():
            return None
        think_enabled = model_flag("THINK")
        answer_tokens = max_new_tokens or int(
            model_env("MAX_NEW_TOKENS", "2048" if think_enabled else "512")
        )
        # Ollama counts hidden reasoning against num_predict. Keep the public
        # max_new_tokens setting as the usable structured-answer allowance and
        # reserve an equal number of tokens for reasoning. A direct
        # NUM_PREDICT override remains available for transport-level tuning.
        num_predict = int(
            model_env(
                "NUM_PREDICT",
                str(answer_tokens * (2 if think_enabled else 1)),
            )
        )
        payload: dict[str, Any] = {
            "model": os.getenv("OURO_ARC_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
            "stream": False,
            "think": think_enabled,
            # Qwen3.5 can loop on one required property when Ollama's full JSON
            # Schema decoder is used for code-heavy objects. JSON mode plus
            # host-side schema validation remains strict without that decoder bug.
            "format": "json",
            "options": {"temperature": 0, "num_predict": num_predict},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }
        encoded_image = _image_for_ollama(image)
        if encoded_image is not None:
            payload["messages"][-1]["images"] = [encoded_image]
        url = os.getenv("OURO_ARC_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
        timeout = float(model_env("TIMEOUT_SECONDS", "300"))
        request = urllib.request.Request(
            f"{url}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
            message = response_payload.get("message", {})
            content = str(message.get("content", "")) if isinstance(message, dict) else ""
            if not content.strip():
                thinking_chars = len(str(message.get("thinking", ""))) if isinstance(message, dict) else 0
                self.last_call_detail = (
                    f"done_reason={response_payload.get('done_reason', '')};"
                    f"thinking_chars={thinking_chars}"
                )
        except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
            status = "timeout" if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower() else "transport_error"
            self._set_call_status(status, repr(exc))
            return None
        return self._parse_json_completion(content, schema)

    def _complete_transformers_json(
        self,
        prompt: str,
        *,
        schema: dict[str, Any],
        image: Any | None,
        system_prompt: str,
        max_new_tokens: int | None,
    ) -> dict[str, Any] | None:
        if not self.load():
            return None
        assert self.processor is not None
        assert self.model is not None
        image_input = _image_for_transformers(image)
        think_enabled = model_flag("THINK")
        answer_tokens = max_new_tokens or int(
            model_env("MAX_NEW_TOKENS", "2048" if think_enabled else "512")
        )
        generation_tokens = answer_tokens * (2 if think_enabled else 1)
        messages = [
            {"role": "system", "content": [{"type": "text", "text": system_prompt}]},
            {
                "role": "user",
                "content": (
                    ([{"type": "image", "image": image_input}] if image_input is not None else [])
                    + [{"type": "text", "text": prompt}]
                ),
            },
        ]
        try:
            inputs = self.processor.apply_chat_template(
                messages,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
                enable_thinking=think_enabled,
            )
            inputs = {
                key: value.to(self.model.device) if hasattr(value, "to") else value
                for key, value in inputs.items()
            }
            input_len = _input_length(inputs.get("input_ids"))
            serialize = _model_flag_default("SERIALIZE_INFERENCE", True)
            generation_context = self._shared_generation_lock if serialize else contextlib.nullcontext()
            with generation_context:
                _seed_transformers_generation(self.call_attempts)
                with _torch_inference_context():
                    output = self.model.generate(
                        **inputs,
                        **_transformers_generation_kwargs(generation_tokens),
                    )
            generated = _generated_tokens(output, input_len)
            decoded = self.processor.decode(generated, skip_special_tokens=False)
            content = _extract_final_response(self.processor, decoded)
        except Exception as exc:
            self._set_call_status("inference_error", repr(exc))
            return None
        return self._parse_json_completion(content, schema)

    def _parse_json_completion(
        self,
        content: str,
        schema: dict[str, Any],
    ) -> dict[str, Any] | None:
        if not content.strip():
            self.empty_content_responses += 1
            self._set_call_status("empty_content", self.last_call_detail)
            return None
        final = _extract_final_response(object(), content)
        match = re.search(r"\{.*\}", final, re.S)
        if match:
            raw = match.group(0)
        elif "{" in final:
            raw = final[final.index("{"):]
        else:
            _debug_model_text("structured parse failed: no json", final)
            self._set_call_status("no_json", _response_excerpt(final))
            return None
        repaired = False
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = _repair_json_object(raw)
            repaired = value is not None
            if value is None:
                value = _repair_repeated_model_source(raw, schema)
                repaired = value is not None
            if value is None:
                value = _repair_code_only_object(raw, schema)
                repaired = value is not None
        if not isinstance(value, dict):
            _debug_model_text("structured parse failed: malformed json", raw)
            self._set_call_status("malformed_json", _response_excerpt(raw))
            return None
        normalized = _normalize_structured_payload(value, schema)
        if normalized != value:
            repaired = True
            value = normalized
        schema_error = _json_schema_error(value, schema)
        if schema_error:
            _debug_model_text("structured schema mismatch", json.dumps(value)[:4000])
            self._set_call_status(
                "schema_mismatch",
                f"{schema_error};{_response_excerpt(json.dumps(value, sort_keys=True))}",
            )
            return None
        self._set_call_status("success", repaired=repaired)
        return value

    def _set_call_status(
        self,
        status: str,
        detail: str = "",
        repaired: bool = False,
    ) -> None:
        self.last_call_status = status
        self.last_call_detail = detail[:500]
        self.last_call_repaired = repaired
        if status != "success":
            self.rejection_counts[status] = self.rejection_counts.get(status, 0) + 1

    def _advise_transformers(
        self,
        prompt: str,
        available_actions: set[int],
        image: Any | None = None,
    ) -> AdvisorPlan | None:
        if not self.load():
            return None
        assert self.processor is not None
        assert self.model is not None
        image_input = _image_for_transformers(image)
        think_enabled = model_flag("THINK")
        max_new_tokens = int(
            model_env(
                "MAX_NEW_TOKENS",
                str(2048 if think_enabled else self.max_new_tokens),
            )
        )

        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": (
                        _advisor_system_prompt()
                    )}
                ],
            },
            {
                "role": "user",
                "content": (
                    ([{"type": "image", "image": image_input}] if image_input is not None else [])
                    + [{"type": "text", "text": prompt}]
                ),
            },
        ]

        try:
            inputs: Any
            if hasattr(self.processor, "apply_chat_template"):
                templated = self.processor.apply_chat_template(
                    messages,
                    add_generation_prompt=True,
                    tokenize=True,
                    return_dict=True,
                    return_tensors="pt",
                    enable_thinking=think_enabled,
                )
                if hasattr(templated, "items"):
                    inputs = templated
                else:
                    inputs = self.processor(
                        text=templated,
                        images=[image_input] if image_input is not None else None,
                        return_tensors="pt",
                    )
            else:
                inputs = self.processor(
                    text=prompt,
                    images=[image_input] if image_input is not None else None,
                    return_tensors="pt",
                )
            inputs = {
                k: v.to(self.model.device) if hasattr(v, "to") else v
                for k, v in inputs.items()
            }
            input_len = _input_length(inputs.get("input_ids"))
            serialize = _model_flag_default("SERIALIZE_INFERENCE", True)
            generation_context = self._shared_generation_lock if serialize else contextlib.nullcontext()
            with generation_context:
                _seed_transformers_generation(self.call_attempts)
                inference_context = _torch_inference_context()
                with inference_context:
                    output = self.model.generate(
                        **inputs,
                        **_transformers_generation_kwargs(max_new_tokens),
                    )
            generated = _generated_tokens(output, input_len)
            decoded = self.processor.decode(generated, skip_special_tokens=False)
            decoded = _extract_final_response(self.processor, decoded)
            if not decoded.strip():
                self.empty_content_responses += 1
                self._set_call_status("empty_content")
                return None
        except Exception as exc:
            # Transient inference failures are not latched: the controller's
            # Failure backoff and the configured call cap bound retry cost.
            # the total cost per game.
            print(f"[ouro-arc] Qwen advise failed, skipping model call: {exc!r}")
            self._set_call_status("inference_error", repr(exc))
            return None
        result = parse_model_plan_result(decoded, available_actions)
        self._set_call_status(result.reason, repaired=result.repaired)
        return result.plan

    def diagnostics(self) -> dict[str, Any]:
        device = str(getattr(self.model, "device", "")) if self.model is not None else ""
        raw_device_map = getattr(self.model, "hf_device_map", {}) if self.model is not None else {}
        device_map = (
            {str(key): str(value) for key, value in raw_device_map.items()}
            if isinstance(raw_device_map, dict)
            else {}
        )
        model_config = getattr(self.model, "config", None) if self.model is not None else None
        raw_quantization = getattr(model_config, "quantization_config", {})
        if hasattr(raw_quantization, "to_dict"):
            raw_quantization = raw_quantization.to_dict()
        quantization = dict(raw_quantization) if isinstance(raw_quantization, dict) else {}
        dtype_numels: dict[str, int] = {}
        device_numels: dict[str, int] = {}
        fp8_module_count = 0
        if self.model is not None:
            try:
                for parameter in self.model.parameters():
                    dtype_name = str(getattr(parameter, "dtype", "unknown"))
                    device_name = str(getattr(parameter, "device", "unknown"))
                    count = int(parameter.numel())
                    dtype_numels[dtype_name] = dtype_numels.get(dtype_name, 0) + count
                    device_numels[device_name] = device_numels.get(device_name, 0) + count
            except (AttributeError, RuntimeError, TypeError):
                pass
            try:
                fp8_module_count = sum(
                    1
                    for module in self.model.modules()
                    if "fp8" in type(module).__name__.casefold()
                )
            except (AttributeError, RuntimeError, TypeError):
                pass
        quant_method = str(quantization.get("quant_method", ""))
        unscaled_fp8_linear_names = _unscaled_fp8_linear_names(self.model)
        quantization_dequantized = bool(quantization.get("dequantize", False))
        has_fp8_parameters = any("float8" in name.casefold() for name in dtype_numels)
        peak_vram_bytes = 0
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                peak_vram_bytes = int(torch.cuda.max_memory_allocated())
        except Exception:
            pass
        return {
            "backend": self.backend,
            "loaded": self.model is not None and self.processor is not None,
            "disabled": self.disabled,
            "failure_reason": self.failure_reason,
            "device": device,
            "device_map": device_map,
            "model_class": type(self.model).__name__ if self.model is not None else "",
            "model_type": str(getattr(model_config, "model_type", "")),
            "quantization_method": quant_method,
            "quantization_dequantized": quantization_dequantized,
            "quantization_active": bool(
                quant_method and not quantization_dequantized and (has_fp8_parameters or fp8_module_count)
            ),
            "fp8_module_count": fp8_module_count,
            "unscaled_fp8_linear_count": len(unscaled_fp8_linear_names),
            "unscaled_fp8_linear_examples": unscaled_fp8_linear_names[:4],
            "parameter_dtype_numels": dict(sorted(dtype_numels.items())),
            "parameter_device_numels": dict(sorted(device_numels.items())),
            "peak_vram_bytes": peak_vram_bytes,
            "load_seconds": round(self.load_seconds, 3),
            "call_attempts": self.call_attempts,
            "call_successes": self.call_successes,
            "call_latencies": [round(value, 3) for value in self.call_latencies],
            "empty_content_responses": self.empty_content_responses,
            "rejection_counts": dict(sorted(self.rejection_counts.items())),
            "repair_count": sum(
                1 for record in self.call_records if bool(record.get("repaired"))
            ),
            "last_call_status": self.last_call_status,
            "call_records": list(self.call_records),
        }

    def _advise_ollama(
        self,
        prompt: str,
        available_actions: set[int],
        image: Any | None = None,
    ) -> AdvisorPlan | None:
        if not self.load():
            return None

        think_enabled = model_flag("THINK")
        num_predict = int(
            model_env(
                "NUM_PREDICT",
                str(self.max_new_tokens * (4 if think_enabled else 1)),
            )
        )
        payload: dict[str, Any] = {
            "model": os.getenv("OURO_ARC_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
            "stream": False,
            "think": think_enabled,
            "format": _ollama_output_format(prompt),
            "options": {
                "temperature": 0,
                "num_predict": num_predict,
            },
            "messages": [
                {
                    "role": "system",
                    "content": _advisor_system_prompt(),
                },
                {"role": "user", "content": prompt},
            ],
        }
        encoded_image = _image_for_ollama(image)
        if encoded_image is not None:
            payload["messages"][-1]["images"] = [encoded_image]

        url = os.getenv("OURO_ARC_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
        timeout = float(model_env("TIMEOUT_SECONDS", "60"))
        request = urllib.request.Request(
            f"{url}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            response_payload = json.loads(raw)
            message = response_payload.get("message", {})
            if not isinstance(message, dict):
                self._set_call_status("invalid_message", repr(message))
                return None
            content = str(message.get("content", ""))
            if not content.strip():
                self.empty_content_responses += 1
                self._set_call_status("empty_content")
                return None
            _debug_model_text("ollama content", content)
        except (
            OSError,
            TimeoutError,
            urllib.error.URLError,
            json.JSONDecodeError,
            ValueError,
        ) as exc:
            print(f"[ouro-arc] Qwen Ollama advise failed, skipping model call: {exc!r}")
            status = (
                "timeout"
                if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower()
                else "transport_error"
            )
            self._set_call_status(status, repr(exc))
            return None
        result = parse_model_plan_result(content, available_actions)
        self._set_call_status(result.reason, repaired=result.repaired)
        return result.plan


def parse_model_plan(text: str, available_actions: set[int]) -> AdvisorPlan | None:
    return parse_model_plan_result(text, available_actions).plan


def advisor_contract_hashes(prompt: str, image: bytes | None = None) -> dict[str, str]:
    """Hash backend-independent inputs that local and Kaggle must share."""

    think = model_flag("THINK")
    max_tokens = int(model_env("MAX_NEW_TOKENS", "2048" if think else "256"))
    values: dict[str, Any] = {
        "prompt": {
            "system": _advisor_system_prompt(),
            "user": prompt,
        },
        "image": hashlib.sha256(image or b"").hexdigest(),
        "schema": _ollama_output_format(prompt),
        "generation": {
            "think": think,
            "max_new_tokens": max_tokens,
            "temperature": float(model_env("TEMPERATURE", "0")),
            "top_p": float(model_env("TOP_P", "1")),
            "top_k": int(model_env("TOP_K", "0")),
            "do_sample": model_flag("DO_SAMPLE"),
            "seed": int(model_env("SEED", "0")),
        },
    }
    return {
        key: hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        for key, value in values.items()
    }


def parse_model_plan_result(
    text: str,
    available_actions: set[int],
) -> PlanParseResult:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        ids = _ordered_hypothesis_ids(text)
        if _hypothesis_policy_enabled() and ids:
            plan = AdvisorPlan(
                mode="hypothesis",
                actions=[],
                hypothesis=ids[0],
                confidence=0.0,
                ranked_hypotheses=tuple(ids),
            )
            return PlanParseResult(plan, "success", repaired=True)
        _debug_model_text("parse failed: no json object", text)
        return PlanParseResult(None, "no_json")
    raw_object = match.group(0)
    repaired = False
    try:
        payload = json.loads(raw_object)
    except json.JSONDecodeError:
        payload = _repair_json_object(raw_object)
        repaired = payload is not None
        if payload is None:
            _debug_model_text("parse failed: malformed json", raw_object)
            return PlanParseResult(None, "malformed_json")
    if not isinstance(payload, dict):
        return PlanParseResult(None, "non_object_json", repaired)
    normalized = {str(key).lower(): value for key, value in payload.items()}
    if normalized != payload:
        repaired = True
    mode = str(normalized.get("mode", "probe"))
    raw_actions = normalized.get("actions", [])
    if not isinstance(raw_actions, list):
        _debug_model_text("parse failed: actions not list", json.dumps(payload)[:1000])
        return PlanParseResult(None, "actions_not_list", repaired)
    actions: list[ActionSpec] = []
    for raw in raw_actions:
        try:
            actions.append(ActionSpec.from_json(raw))
        except (TypeError, ValueError):
            _debug_model_text("parse skipped invalid action", repr(raw))
            continue
    actions = filter_legal_actions(actions, available_actions)
    hypothesis = str(normalized.get("hypothesis", "")).strip()
    raw_ranking = normalized.get("ranked_hypotheses", [])
    if isinstance(raw_ranking, str):
        raw_ranking = [raw_ranking]
        repaired = True
    if not isinstance(raw_ranking, list):
        return PlanParseResult(None, "ranking_not_list", repaired)
    ranked = _dedupe_strings([str(item).strip() for item in raw_ranking])
    if hypothesis and hypothesis not in ranked:
        ranked.insert(0, hypothesis)
    elif not hypothesis and ranked:
        hypothesis = ranked[0]
        repaired = True
    hypothesis_only = mode.lower() in {"hypothesis", "hypotheses", "induction"}
    if not actions and not (hypothesis_only and hypothesis.strip()):
        _debug_model_text("parse failed: no legal actions", json.dumps(payload)[:1000])
        reason = "empty_hypothesis" if hypothesis_only else "no_legal_actions"
        return PlanParseResult(None, reason, repaired)
    try:
        confidence = float(normalized.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
        repaired = True
    return PlanParseResult(
        AdvisorPlan(
            mode=mode,
            actions=actions,
            hypothesis=hypothesis,
            confidence=max(0.0, min(1.0, confidence)),
            ranked_hypotheses=tuple(ranked),
        ),
        "success",
        repaired,
    )


def _repair_json_object(text: str) -> dict[str, Any] | None:
    repaired = re.sub(r",\s*([}\]])", r"\1", text.strip())
    try:
        value = json.loads(repaired)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    try:
        value = ast.literal_eval(repaired)
        return value if isinstance(value, dict) else None
    except (SyntaxError, ValueError):
        return None


def _repair_code_only_object(
    text: str,
    schema: dict[str, Any],
) -> dict[str, Any] | None:
    """Repair Qwen's observed ``{"<entire Python program>"}`` response."""

    match = re.fullmatch(r"\{\s*(\"(?:\\.|[^\"\\])*\")\s*\}", text.strip(), re.S)
    if not match:
        return None
    try:
        source = json.loads(match.group(1))
    except json.JSONDecodeError:
        source = match.group(1)[1:-1]
        source = source.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    if (
        not isinstance(source, str)
        or "def parse_observation" not in source
        or "def step" not in source
        or "def render" not in source
    ):
        return None
    properties = schema.get("properties", {})
    lines = source.splitlines()
    if "model_source" in properties:
        source_value: Any = source
        if properties.get("model_source", {}).get("type") == "array":
            source_value = lines
        return {
            "model_source": source_value,
            "notes": "repaired code-only response",
            "experiment": None,
            "helpers": [],
        }
    if "verdict" in properties:
        return {
            "verdict": "revise",
            "issues": ["critic returned a replacement program without wrapper fields"],
            "counterexample_indexes": [],
        }
    return None


def _repair_repeated_model_source(
    text: str,
    schema: dict[str, Any],
) -> dict[str, Any] | None:
    """Recover the first complete source value from Qwen's repeated-key loop."""

    if "model_source" not in schema.get("properties", {}):
        return None
    match = re.search(r'"model_source"\s*:\s*', text)
    if match is None:
        return None
    try:
        source, _ = json.JSONDecoder().raw_decode(text[match.end():])
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(source, str) or "def parse_observation" not in source or "def step" not in source:
        return None
    return {
        "model_source": source,
        "notes": "repaired repeated model_source response",
        "experiment": None,
        "helpers": [],
    }


def _json_schema_error(value: Any, schema: dict[str, Any], path: str = "$") -> str:
    expected = schema.get("type")
    if isinstance(expected, list):
        if value is None and "null" in expected:
            return ""
        non_null = [item for item in expected if item != "null"]
        return _json_schema_error(value, {**schema, "type": non_null[0] if non_null else None}, path)
    type_checks = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }
    if expected in type_checks and not type_checks[expected](value):
        return f"{path} must be {expected}"
    if "enum" in schema and value not in schema["enum"]:
        return f"{path} is not an allowed value"
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                return f"{path}.{key} is required"
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            unknown = set(value) - set(properties)
            if unknown:
                return f"{path} has unknown properties: {', '.join(sorted(unknown))}"
        for key, child in properties.items():
            if key in value:
                error = _json_schema_error(value[key], child, f"{path}.{key}")
                if error:
                    return error
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            return f"{path} has too many items"
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            return f"{path} has too few items"
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                error = _json_schema_error(item, item_schema, f"{path}[{index}]")
                if error:
                    return error
    return ""


def _normalize_structured_payload(
    value: dict[str, Any],
    schema: dict[str, Any],
) -> dict[str, Any]:
    properties = schema.get("properties", {})
    normalized = (
        {key: item for key, item in value.items() if key in properties}
        if schema.get("additionalProperties") is False
        else dict(value)
    )
    if "model_source" in properties and isinstance(normalized.get("model_source"), str):
        defaults = {"notes": "", "experiment": None, "helpers": []}
        for key, default in defaults.items():
            if key in properties:
                normalized.setdefault(key, default)
    if "verdict" in properties and str(normalized.get("verdict", "")) in {"accept", "revise", "reject"}:
        normalized.setdefault("issues", [])
        normalized.setdefault("counterexample_indexes", [])
        if "approved_helpers" in properties:
            normalized.setdefault("approved_helpers", [])
    return normalized


def _dedupe_strings(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value.lower() in seen:
            continue
        seen.add(value.lower())
        result.append(value)
    return result


def _ordered_hypothesis_ids(text: str) -> list[str]:
    return _dedupe_strings(re.findall(r"\bh-a\d+-x(?:n|-?\d+)-y(?:n|-?\d+)\b", text, re.I))


def _hypothesis_policy_enabled() -> bool:
    return model_env("POLICY", "sparse").lower() in {
        "hypothesis",
        "hypotheses",
        "induction",
    }


def _ollama_output_format(prompt: str) -> str | dict[str, Any]:
    if not _hypothesis_policy_enabled():
        return "json"
    ids = _ordered_hypothesis_ids(prompt)
    id_schema: dict[str, Any] = {"type": "string"}
    if ids:
        id_schema["enum"] = ids
    return {
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["hypothesis"]},
            "actions": {"type": "array", "items": {}, "maxItems": 0},
            "hypothesis": dict(id_schema),
            "ranked_hypotheses": {
                "type": "array",
                "items": dict(id_schema),
                "minItems": 1,
                "maxItems": max(1, min(3, len(ids))),
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": [
            "mode",
            "actions",
            "hypothesis",
            "ranked_hypotheses",
            "confidence",
        ],
        "additionalProperties": False,
    }


def _advisor_system_prompt() -> str:
    policy = model_env("POLICY", "sparse").lower()
    if policy in {"hypothesis", "hypotheses", "induction"}:
        return (
            "You rank deterministic ARC mechanic hypotheses. Return only strict JSON "
            "with keys mode, actions, hypothesis, confidence. Set mode to hypothesis, "
            "ranked_hypotheses, and confidence. Set mode to hypothesis, set actions "
            "to an empty list, rank only supplied hypothesis ids best-first in "
            "ranked_hypotheses, and repeat the first id in hypothesis. Do not propose "
            "or emit game actions. Do not use markdown."
        )
    return (
        "You are an ARC-AGI-3 game strategist. Return only strict JSON with keys "
        "mode, actions, hypothesis, confidence. Use only currently legal actions. "
        "For click action 6, include integer x and y coordinates from a candidate "
        "when possible. Example: "
        '{"mode":"probe","actions":[{"action":1}],"hypothesis":"...",'
        '"confidence":0.0}. Do not use markdown.'
    )


def _model_flag_default(name: str, default: bool) -> bool:
    raw = model_env(name)
    if raw is None or not raw.strip():
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _input_length(input_ids: Any) -> int:
    shape = getattr(input_ids, "shape", None)
    if shape is not None and len(shape):
        return int(shape[-1])
    try:
        first = input_ids[0]
        return len(first)
    except (TypeError, IndexError, KeyError):
        return 0


def _generated_tokens(output: Any, input_len: int) -> Any:
    sequence = output[0]
    if input_len <= 0:
        return sequence
    return sequence[input_len:]


def _torch_inference_context() -> Any:
    try:
        import torch  # type: ignore

        return torch.inference_mode()
    except (ImportError, AttributeError):
        return contextlib.nullcontext()


def _repair_qwen_fp8_skip_patterns(config: Any) -> int:
    """Prevent Qwen's ``mlp.gate`` skip regex from shadowing ``gate_proj``."""

    quantization = getattr(config, "quantization_config", None)
    patterns = (
        quantization.get("modules_to_not_convert")
        if isinstance(quantization, dict)
        else getattr(quantization, "modules_to_not_convert", None)
    )
    if not isinstance(patterns, list):
        return 0
    repaired = [
        pattern
        for pattern in patterns
        if not (isinstance(pattern, str) and pattern.endswith(".mlp.gate"))
    ]
    removed = len(patterns) - len(repaired)
    if isinstance(quantization, dict):
        quantization["modules_to_not_convert"] = repaired
    else:
        quantization.modules_to_not_convert = repaired
    return removed


def _unscaled_fp8_linear_names(model: Any) -> list[str]:
    if model is None or not hasattr(model, "named_modules"):
        return []
    try:
        modules = model.named_modules()
    except Exception:
        return []
    result: list[str] = []
    for name, module in modules:
        weight = getattr(module, "weight", None)
        if "float8" not in str(getattr(weight, "dtype", "")).lower():
            continue
        if getattr(module, "weight_scale_inv", None) is None:
            result.append(str(name))
    return sorted(result)


def _transformers_generation_kwargs(max_new_tokens: int) -> dict[str, Any]:
    do_sample = model_flag("DO_SAMPLE")
    kwargs: dict[str, Any] = {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
    }
    if do_sample:
        kwargs.update(
            {
                "temperature": float(model_env("TEMPERATURE", "1.0")),
                "top_p": float(model_env("TOP_P", "0.95")),
                "top_k": int(model_env("TOP_K", "20")),
            }
        )
    return kwargs


def _seed_transformers_generation(attempt: int) -> None:
    if not model_flag("DO_SAMPLE"):
        return
    try:
        import torch  # type: ignore

        torch.manual_seed(int(model_env("SEED", "0")) + max(0, attempt - 1))
    except (ImportError, AttributeError, TypeError, ValueError):
        pass


def _response_excerpt(text: str) -> str:
    compact = " ".join(text.split())
    return "final_excerpt=" + compact[:460]


def _extract_final_response(processor: Any, decoded: str) -> str:
    """Extract assistant final content without ever treating reasoning as JSON."""

    if hasattr(processor, "parse_response"):
        try:
            parsed = processor.parse_response(decoded)
            content = _content_from_parsed_response(parsed)
            if content.strip():
                return content
        except Exception:
            pass
    closing = list(re.finditer(r"</think>", decoded, flags=re.I))
    if closing:
        decoded = decoded[closing[-1].end():]
    elif re.search(r"<think>", decoded, flags=re.I):
        return ""
    text = re.sub(r"<think>.*?</think>", "", decoded, flags=re.I | re.S)
    text = re.sub(r"<analysis>.*?</analysis>", "", text, flags=re.I | re.S)
    return text.strip()


def _content_from_parsed_response(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("content", "text", "final", "message"):
            if key in value:
                result = _content_from_parsed_response(value[key])
                if result.strip():
                    return result
        return ""
    if isinstance(value, (list, tuple)):
        for item in reversed(value):
            result = _content_from_parsed_response(item)
            if result.strip():
                return result
    return ""


def _debug_model_text(label: str, text: str) -> None:
    if not model_flag("DEBUG"):
        return
    limit = int(model_env("DEBUG_CHARS", "1200"))
    snippet = text[:limit].replace("\n", "\\n")
    suffix = "" if len(text) <= limit else "...<truncated>"
    print(f"[ouro-arc] model debug {label}: {snippet}{suffix}")


# Temporary compatibility aliases for existing imports and recorded fixtures.
GemmaAdvisor = ModelAdvisor
GemmaPlan = AdvisorPlan


def _image_for_ollama(image: Any | None) -> str | None:
    if image is None:
        return None
    if isinstance(image, bytes):
        return base64.b64encode(image).decode("ascii")
    if isinstance(image, str):
        return image
    return None


def _image_for_transformers(image: Any | None) -> Any | None:
    if not isinstance(image, bytes):
        return image
    try:
        from PIL import Image  # type: ignore

        return Image.open(io.BytesIO(image)).convert("RGB")
    except Exception:
        return image
