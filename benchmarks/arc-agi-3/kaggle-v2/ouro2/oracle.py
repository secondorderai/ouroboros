"""Optional LLM selector. The 4B never authors content: it picks one item
from a CPU-generated list of choices, as JSON, at temperature 0, thinking
off. Any failure — transport, timeout, malformed JSON, out-of-menu answer
— returns the CPU default. The 0-call mode (oracle=None) is the product;
this is a tie-breaker, not a dependency.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.request

from .config import Config

_GENERATION_LOCK = threading.Lock()  # one shared model across game threads

SYSTEM = (
    "You analyze a grid puzzle game. Answer with JSON only: "
    '{"choice": "<one of the offered options, verbatim>"}'
)


class Oracle:
    def __init__(self, config: Config, transport=None) -> None:
        self.config = config
        self.transport = transport  # injectable for tests
        self.calls_used = 0
        self.failures = 0
        self._model = None
        self._tokenizer = None
        self._load_failed = False
        self._load_attempts = 0

    def select(self, kind: str, question: str, choices: list[str], default: str) -> str:
        if not choices or len(choices) == 1:
            return default
        if self.calls_used >= self.config.model_max_calls:
            return default
        prompt = (
            f"[{kind}] {question}\nOptions:\n"
            + "\n".join(f"- {c}" for c in choices)
            + '\nAnswer with JSON: {"choice": "..."}'
        )
        self.calls_used += 1
        try:
            with _GENERATION_LOCK:
                raw = (
                    self.transport(prompt)
                    if self.transport is not None
                    else self._complete(prompt)
                )
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            answer = json.loads(match.group(0)) if match else {}
            choice = answer.get("choice")
            if choice in choices:
                return choice
        except Exception:  # noqa: BLE001 — fail open to the CPU default
            pass
        self.failures += 1
        return default

    # -- transports ------------------------------------------------------
    def _complete(self, prompt: str) -> str:
        if self.config.model_backend == "ollama":
            return self._ollama(prompt)
        return self._transformers(prompt)

    def _ollama(self, prompt: str) -> str:
        payload = json.dumps(
            {
                "model": self.config.model_path or "qwen3.5:4b-mlx",
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                "stream": False,
                "think": False,
                "format": "json",
                "options": {"temperature": 0, "num_predict": 160},
            }
        ).encode()
        req = urllib.request.Request(
            "http://127.0.0.1:11434/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
        return body.get("message", {}).get("content", "")

    def _transformers(self, prompt: str) -> str:
        if self._model is None:
            # A failed load never succeeds later in-run (bad path, missing
            # dep, unknown architecture) but costs ~20s per retry; latch off
            # after one attempt so select() fails open instantly thereafter.
            if self._load_failed:
                raise RuntimeError("transformers model previously failed to load")
            self._load_attempts += 1
            try:
                import torch
                from transformers import AutoModelForCausalLM, AutoTokenizer

                self._tokenizer = AutoTokenizer.from_pretrained(self.config.model_path)
                self._model = AutoModelForCausalLM.from_pretrained(
                    self.config.model_path,
                    torch_dtype=torch.bfloat16,
                    device_map={"": "cuda:0"},
                )
            except Exception:
                self._load_failed = True
                raise
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ]
        text = self._tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = self._tokenizer(text, return_tensors="pt").to(self._model.device)
        out = self._model.generate(
            **inputs, max_new_tokens=160, do_sample=False,
            pad_token_id=self._tokenizer.eos_token_id,
        )
        return self._tokenizer.decode(
            out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True
        )
