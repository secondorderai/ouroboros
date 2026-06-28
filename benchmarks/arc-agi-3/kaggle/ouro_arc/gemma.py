from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .actions import ActionSpec, filter_legal_actions

DEFAULT_MODEL_CANDIDATES = (
    "/kaggle/input/models/google/gemma-4/transformers/gemma-4-12b-it/2",
    "/kaggle/input/models/google/gemma-4/transformers/gemma-4-12b-it",
    "/kaggle/input/models/google/gemma-4/transformers",
    "/kaggle/input/models/google/gemma-4",
)


@dataclass
class GemmaPlan:
    mode: str
    actions: list[ActionSpec]
    hypothesis: str = ""
    confidence: float = 0.0


class GemmaAdvisor:
    """Lazy offline Gemma 4 12B advisor.

    The controller treats this as optional during local smoke tests. In Kaggle
    competition reruns `require_model=True` makes missing weights a hard error.
    """

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

    @property
    def disabled(self) -> bool:
        return os.getenv("OURO_ARC_DISABLE_MODEL", "").lower() in {"1", "true", "yes"}

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
            raise FileNotFoundError(
                "Gemma 4 12B Unified model input was not found. "
                f"Set OURO_ARC_MODEL_PATH or attach it under one of: {searched}"
            )
        return resolved

    def load(self) -> bool:
        if self.model is not None and self.processor is not None:
            return True
        model_path = self.ensure_available()
        if model_path is None:
            return False
        try:
            from transformers import AutoProcessor  # type: ignore

            try:
                from transformers import AutoModelForMultimodalLM  # type: ignore
            except ImportError:
                try:
                    from transformers import AutoModelForImageTextToText as AutoModelForMultimodalLM  # type: ignore
                except ImportError:
                    from transformers import AutoModelForCausalLM as AutoModelForMultimodalLM  # type: ignore
        except ImportError as exc:
            if self.require_model:
                raise RuntimeError(
                    "transformers is required to load Gemma 4 12B Unified"
                ) from exc
            return False

        self.processor = AutoProcessor.from_pretrained(
            str(model_path), local_files_only=True
        )
        self.model = AutoModelForMultimodalLM.from_pretrained(
            str(model_path),
            local_files_only=True,
            dtype="auto",
            device_map="auto",
        )
        return True

    def advise(
        self,
        prompt: str,
        available_actions: set[int],
        image: Any | None = None,
    ) -> GemmaPlan | None:
        if not self.load():
            return None
        assert self.processor is not None
        assert self.model is not None

        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "You are an ARC-AGI-3 game strategist. Return only strict JSON "
                    "with keys mode, actions, hypothesis, confidence."
                ),
            },
            {"role": "user", "content": prompt},
        ]
        if image is not None:
            messages[-1]["images"] = [image]

        try:
            if hasattr(self.processor, "apply_chat_template"):
                text = self.processor.apply_chat_template(
                    messages,
                    add_generation_prompt=True,
                    tokenize=False,
                )
            else:
                text = prompt
            inputs = self.processor(
                text=text,
                images=[image] if image is not None else None,
                return_tensors="pt",
            )
            inputs = {
                k: v.to(self.model.device) if hasattr(v, "to") else v
                for k, v in inputs.items()
            }
            output = self.model.generate(
                **inputs, max_new_tokens=self.max_new_tokens, do_sample=False
            )
            decoded = self.processor.decode(output[0], skip_special_tokens=True)
        except Exception:
            if self.require_model:
                raise
            return None
        return parse_model_plan(decoded, available_actions)


def parse_model_plan(text: str, available_actions: set[int]) -> GemmaPlan | None:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    raw_actions = payload.get("actions", [])
    if not isinstance(raw_actions, list):
        return None
    actions: list[ActionSpec] = []
    for raw in raw_actions:
        try:
            actions.append(ActionSpec.from_json(raw))
        except (TypeError, ValueError):
            continue
    actions = filter_legal_actions(actions, available_actions)
    if not actions:
        return None
    try:
        confidence = float(payload.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return GemmaPlan(
        mode=str(payload.get("mode", "probe")),
        actions=actions,
        hypothesis=str(payload.get("hypothesis", "")),
        confidence=max(0.0, min(1.0, confidence)),
    )
