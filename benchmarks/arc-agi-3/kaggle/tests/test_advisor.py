from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from ouro_arc.advisor import (
    DEFAULT_OLLAMA_MODEL,
    ModelAdvisor,
    _repair_qwen_fp8_skip_patterns,
    _unscaled_fp8_linear_names,
    parse_model_plan,
    parse_model_plan_result,
)
from ouro_arc.gemma import GemmaAdvisor, GemmaPlan


class ModelAdvisorTest(unittest.TestCase):
    def test_legacy_import_aliases_remain_available(self) -> None:
        self.assertIs(GemmaAdvisor, ModelAdvisor)
        self.assertEqual(GemmaPlan.__name__, "AdvisorPlan")

    def setUp(self) -> None:
        self._old_backend = os.environ.get("OURO_ARC_MODEL_BACKEND")
        self._old_think = os.environ.get("OURO_ARC_MODEL_THINK")
        self._old_url = os.environ.get("OURO_ARC_OLLAMA_URL")
        self._old_model = os.environ.get("OURO_ARC_OLLAMA_MODEL")
        self._old_num_predict = os.environ.get("OURO_ARC_MODEL_NUM_PREDICT")
        self._old_max_new_tokens = os.environ.get("OURO_ARC_MODEL_MAX_NEW_TOKENS")
        self._old_serialize = os.environ.get("OURO_ARC_MODEL_SERIALIZE_INFERENCE")
        self._old_require_cuda = os.environ.get("OURO_ARC_MODEL_REQUIRE_CUDA")
        self._old_dtype = os.environ.get("OURO_ARC_MODEL_DTYPE")
        self._old_policy = os.environ.get("OURO_ARC_MODEL_POLICY")
        ModelAdvisor.clear_shared_runtime_for_tests()

    def tearDown(self) -> None:
        for key, value in (
            ("OURO_ARC_MODEL_BACKEND", self._old_backend),
            ("OURO_ARC_MODEL_THINK", self._old_think),
            ("OURO_ARC_OLLAMA_URL", self._old_url),
            ("OURO_ARC_OLLAMA_MODEL", self._old_model),
            ("OURO_ARC_MODEL_NUM_PREDICT", self._old_num_predict),
            ("OURO_ARC_MODEL_MAX_NEW_TOKENS", self._old_max_new_tokens),
            ("OURO_ARC_MODEL_SERIALIZE_INFERENCE", self._old_serialize),
            ("OURO_ARC_MODEL_REQUIRE_CUDA", self._old_require_cuda),
            ("OURO_ARC_MODEL_DTYPE", self._old_dtype),
            ("OURO_ARC_MODEL_POLICY", self._old_policy),
        ):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_parse_model_plan_returns_legal_actions_only(self) -> None:
        plan = parse_model_plan(
            '{"mode":"probe","actions":[{"action":1},{"action":6,"x":9,"y":8},{"action":4}],'
            '"hypothesis":"move then click","confidence":0.8}',
            {1, 6},
        )
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual([action.action for action in plan.actions], [1, 6])
        self.assertEqual(plan.confidence, 0.8)

    def test_parse_hypothesis_response_allows_empty_actions(self) -> None:
        plan = parse_model_plan(
            '{"mode":"hypothesis","actions":[],"hypothesis":"h-a2-xn-yn",'
            '"confidence":0.9}',
            {1, 2},
        )
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(plan.actions, [])
        self.assertEqual(plan.hypothesis, "h-a2-xn-yn")
        self.assertEqual(plan.confidence, 0.9)

    def test_parse_ranked_hypotheses_preserves_order_and_deduplicates(self) -> None:
        plan = parse_model_plan(
            '{"mode":"hypothesis","actions":[],"hypothesis":"h-a2-xn-yn",'
            '"ranked_hypotheses":["h-a2-xn-yn","h-a1-xn-yn","h-a2-xn-yn"],'
            '"confidence":0.6}',
            {1, 2},
        )

        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(
            plan.ranked_hypotheses,
            ("h-a2-xn-yn", "h-a1-xn-yn"),
        )

    def test_deterministic_repair_handles_python_style_hypothesis_json(self) -> None:
        os.environ["OURO_ARC_MODEL_POLICY"] = "hypothesis"
        result = parse_model_plan_result(
            "{'MODE':'hypothesis','ACTIONS':[],'HYPOTHESIS':'h-a2-xn-yn',"
            "'RANKED_HYPOTHESES':['h-a2-xn-yn',], 'CONFIDENCE':'bad',}",
            {1, 2},
        )

        self.assertIsNotNone(result.plan)
        self.assertTrue(result.repaired)
        self.assertEqual(result.reason, "success")
        assert result.plan is not None
        self.assertEqual(result.plan.hypothesis, "h-a2-xn-yn")
        self.assertEqual(result.plan.confidence, 0.0)

    def test_plain_hypothesis_id_is_repaired_only_for_hypothesis_policy(self) -> None:
        os.environ["OURO_ARC_MODEL_POLICY"] = "hypothesis"
        result = parse_model_plan_result("h-a2-xn-yn", {1, 2})
        self.assertIsNotNone(result.plan)
        self.assertTrue(result.repaired)

    def test_missing_required_model_degrades_without_raising(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "missing")
            advisor = ModelAdvisor(model_path=missing, require_model=True)
            self.assertIsNone(advisor.ensure_available())
            self.assertTrue(advisor.disabled)
            self.assertIn("model input not found", advisor.failure_reason or "")

    def test_load_failure_latches_advisor_off(self) -> None:
        # An existing directory without model weights makes load() fail either
        # at the transformers import or at from_pretrained; both must latch the
        # advisor off instead of raising, and must not retry the load.
        with tempfile.TemporaryDirectory() as tmp:
            advisor = ModelAdvisor(model_path=tmp, require_model=True)
            self.assertFalse(advisor.load())
            self.assertTrue(advisor.disabled)
            self.assertFalse(advisor.load())
            self.assertIsNone(advisor.advise("prompt", {1}))

    def test_diagnostics_report_active_fp8_and_parameter_placement(self) -> None:
        class Parameter:
            dtype = "torch.float8_e4m3fn"
            device = "cuda:0"

            def numel(self) -> int:
                return 42

        class FP8Linear:
            pass

        model = SimpleNamespace(
            device="cuda:0",
            hf_device_map={"": "cuda:0"},
            config=SimpleNamespace(
                model_type="qwen3_5",
                quantization_config={"quant_method": "fp8", "dequantize": False},
            ),
            parameters=lambda: [Parameter()],
            modules=lambda: [FP8Linear()],
        )
        advisor = ModelAdvisor()
        advisor.model = model
        advisor.processor = object()

        diagnostics = advisor.diagnostics()

        self.assertEqual(diagnostics["quantization_method"], "fp8")
        self.assertTrue(diagnostics["quantization_active"])
        self.assertFalse(diagnostics["quantization_dequantized"])
        self.assertEqual(diagnostics["fp8_module_count"], 1)
        self.assertEqual(
            diagnostics["parameter_device_numels"], {"cuda:0": 42}
        )

    def test_advise_swallows_inference_exceptions(self) -> None:
        class BoomProcessor:
            def apply_chat_template(self, *args: object, **kwargs: object) -> str:
                raise RuntimeError("template boom")

        advisor = ModelAdvisor(model_path="/does/not/matter", require_model=True)
        advisor.processor = BoomProcessor()
        advisor.model = object()
        self.assertIsNone(advisor.advise("prompt", {1, 6}))
        # Inference failures are transient: the advisor is not latched off.
        self.assertFalse(advisor.disabled)

    def test_disable_model_allows_missing_path(self) -> None:
        old = os.environ.get("OURO_ARC_DISABLE_MODEL")
        os.environ["OURO_ARC_DISABLE_MODEL"] = "1"
        try:
            advisor = ModelAdvisor(model_path="/does/not/exist", require_model=True)
            self.assertIsNone(advisor.ensure_available())
        finally:
            if old is None:
                os.environ.pop("OURO_ARC_DISABLE_MODEL", None)
            else:
                os.environ["OURO_ARC_DISABLE_MODEL"] = old

    def test_ollama_payload_defaults_to_json_vision_without_thinking(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ.pop("OURO_ARC_OLLAMA_MODEL", None)
        captured: list[dict[str, object]] = []

        def fake_urlopen(request: object, timeout: float):
            import json

            payload = json.loads(request.data.decode("utf-8"))  # type: ignore[attr-defined]
            captured.append(payload)
            return FakeResponse(
                {
                    "message": {
                        "thinking": "ignore this",
                        "content": '{"mode":"probe","actions":[{"action":1}],'
                        '"hypothesis":"ok","confidence":0.7}',
                    }
                }
            )

        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            plan = ModelAdvisor(max_new_tokens=32).advise("prompt", {1}, image=b"png")

        self.assertIsNotNone(plan)
        self.assertEqual(captured[0]["model"], DEFAULT_OLLAMA_MODEL)
        self.assertEqual(captured[0]["format"], "json")
        self.assertEqual(captured[0]["think"], False)
        self.assertEqual(captured[0]["options"], {"temperature": 0, "num_predict": 32})
        messages = captured[0]["messages"]  # type: ignore[index]
        self.assertEqual(messages[1]["images"], ["cG5n"])  # type: ignore[index]

    def test_ollama_thinking_is_opt_in_and_uses_larger_budget(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ["OURO_ARC_MODEL_THINK"] = "1"
        captured: list[dict[str, object]] = []

        def fake_urlopen(request: object, timeout: float):
            import json

            payload = json.loads(request.data.decode("utf-8"))  # type: ignore[attr-defined]
            captured.append(payload)
            return FakeResponse(
                {
                    "message": {
                        "thinking": "private reasoning",
                        "content": '{"mode":"probe","actions":[{"action":1}],'
                        '"hypothesis":"ok","confidence":0.7}',
                    }
                }
            )

        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            plan = ModelAdvisor(max_new_tokens=32).advise("prompt", {1})

        self.assertIsNotNone(plan)
        self.assertEqual(captured[0]["think"], True)
        self.assertEqual(captured[0]["options"], {"temperature": 0, "num_predict": 128})

    def test_hypothesis_policy_system_prompt_forbids_model_actions(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ["OURO_ARC_MODEL_POLICY"] = "hypothesis"
        captured: list[dict[str, object]] = []

        def fake_urlopen(request: object, timeout: float):
            payload = json.loads(request.data.decode("utf-8"))  # type: ignore[attr-defined]
            captured.append(payload)
            return FakeResponse(
                {
                    "message": {
                        "content": '{"mode":"hypothesis","actions":[],'
                        '"hypothesis":"h-a2-xn-yn",'
                        '"ranked_hypotheses":["h-a2-xn-yn","h-a1-xn-yn"],'
                        '"confidence":1}'
                    }
                }
            )

        advisor = ModelAdvisor()
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            plan = advisor.advise(
                "h-a2-xn-yn: first\nh-a1-xn-yn: second",
                {1, 2},
            )

        self.assertIsNotNone(plan)
        messages = captured[0]["messages"]  # type: ignore[index]
        self.assertIn("Do not propose or emit game actions", messages[0]["content"])  # type: ignore[index]
        schema = captured[0]["format"]
        self.assertIsInstance(schema, dict)
        self.assertEqual(
            schema["properties"]["hypothesis"]["enum"],  # type: ignore[index]
            ["h-a2-xn-yn", "h-a1-xn-yn"],
        )
        self.assertEqual(
            advisor.diagnostics()["call_records"][0]["candidate_hypothesis_ids"],
            ["h-a2-xn-yn", "h-a1-xn-yn"],
        )

    def test_ollama_rejection_telemetry_records_parse_reason(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"

        def fake_urlopen(request: object, timeout: float):
            return FakeResponse({"message": {"content": "not json"}})

        advisor = ModelAdvisor()
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            self.assertIsNone(advisor.advise("prompt", {1}))

        diagnostics = advisor.diagnostics()
        self.assertEqual(diagnostics["last_call_status"], "no_json")
        self.assertEqual(diagnostics["rejection_counts"], {"no_json": 1})
        self.assertEqual(diagnostics["call_records"][0]["status"], "no_json")
        self.assertEqual(
            diagnostics["call_records"][0]["candidate_hypothesis_ids"],
            [],
        )

    def test_ollama_num_predict_can_be_overridden(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ["OURO_ARC_MODEL_THINK"] = "1"
        os.environ["OURO_ARC_MODEL_NUM_PREDICT"] = "4096"
        captured: list[dict[str, object]] = []

        def fake_urlopen(request: object, timeout: float):
            import json

            payload = json.loads(request.data.decode("utf-8"))  # type: ignore[attr-defined]
            captured.append(payload)
            return FakeResponse(
                {
                    "message": {
                        "content": '{"mode":"probe","actions":[{"action":1}],'
                        '"hypothesis":"ok","confidence":0.7}',
                    }
                }
            )

        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            plan = ModelAdvisor(max_new_tokens=32).advise("prompt", {1})

        self.assertIsNotNone(plan)
        self.assertEqual(captured[0]["options"], {"temperature": 0, "num_predict": 4096})

    def test_ollama_malformed_content_fails_open(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"

        def fake_urlopen(request: object, timeout: float):
            return FakeResponse({"message": {"thinking": '{"actions":[{"action":1}]}', "content": ""}})

        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            self.assertIsNone(ModelAdvisor().advise("prompt", {1}))

    def test_transformers_backend_forwards_image_to_processor(self) -> None:
        image = object()
        advisor = ModelAdvisor(model_path="/does/not/matter")
        processor = RecordingProcessor()
        advisor.processor = processor
        advisor.model = RecordingModel()

        plan = advisor.advise("prompt", {1}, image=image)

        self.assertIsNotNone(plan)
        self.assertEqual(processor.images, [image])

    def test_transformers_uses_structured_image_message_and_thinking_flag(self) -> None:
        os.environ["OURO_ARC_MODEL_THINK"] = "1"
        os.environ["OURO_ARC_MODEL_MAX_NEW_TOKENS"] = "99"
        image = object()
        processor = RecordingProcessor()
        model = RecordingModel()
        advisor = ModelAdvisor()
        advisor.processor = processor
        advisor.model = model

        plan = advisor.advise("scientist prompt", {1}, image=image)

        self.assertIsNotNone(plan)
        assert processor.messages is not None
        user_content = processor.messages[1]["content"]
        self.assertEqual(user_content[0], {"type": "image", "image": image})
        self.assertEqual(user_content[1], {"type": "text", "text": "scientist prompt"})
        self.assertTrue(processor.template_kwargs["enable_thinking"])
        self.assertEqual(model.max_new_tokens, 99)

    def test_transformers_decodes_only_generated_tokens_and_final_content(self) -> None:
        processor = SlicingProcessor()
        advisor = ModelAdvisor()
        advisor.processor = processor
        advisor.model = SlicingModel()

        plan = advisor.advise("prompt schema {\"actions\":[]}", {1})

        self.assertIsNotNone(plan)
        self.assertEqual(processor.decoded_tokens, ["generated-json"])
        assert plan is not None
        self.assertEqual(plan.hypothesis, "final only")

    def test_qwen_thinking_is_removed_before_json_parsing(self) -> None:
        processor = ThinkingProcessor()
        advisor = ModelAdvisor()
        advisor.processor = processor
        advisor.model = SlicingModel()
        plan = advisor.advise("prompt", {1})
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(plan.hypothesis, "final json")

    def test_transformers_generation_is_serialized_across_advisors(self) -> None:
        os.environ["OURO_ARC_MODEL_SERIALIZE_INFERENCE"] = "1"
        model = ConcurrentRecordingModel()
        advisors = []
        for _ in range(2):
            advisor = ModelAdvisor()
            advisor.processor = RecordingProcessor()
            advisor.model = model
            advisors.append(advisor)
        threads = [threading.Thread(target=advisor.advise, args=("prompt", {1})) for advisor in advisors]

        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(model.max_concurrent, 1)

    def test_transformers_sampling_is_profile_controlled_and_seeded(self) -> None:
        processor = RecordingProcessor()
        model = RecordingModel()
        advisor = ModelAdvisor()
        advisor.processor = processor
        advisor.model = model
        fake_torch = types.ModuleType("torch")
        fake_torch.inference_mode = lambda: contextlib.nullcontext()  # type: ignore[attr-defined]
        seeds: list[int] = []
        fake_torch.manual_seed = seeds.append  # type: ignore[attr-defined]
        with patch.dict(
            os.environ,
            {
                "OURO_ARC_MODEL_DO_SAMPLE": "1",
                "OURO_ARC_MODEL_TEMPERATURE": "0.7",
                "OURO_ARC_MODEL_TOP_P": "0.8",
                "OURO_ARC_MODEL_TOP_K": "20",
                "OURO_ARC_MODEL_SEED": "11",
            },
            clear=False,
        ), patch.dict(sys.modules, {"torch": fake_torch}):
            self.assertIsNotNone(advisor.advise("prompt", {1}))

        self.assertEqual(seeds, [11])
        self.assertTrue(model.generation_kwargs["do_sample"])
        self.assertEqual(model.generation_kwargs["temperature"], 0.7)
        self.assertEqual(model.generation_kwargs["top_p"], 0.8)
        self.assertEqual(model.generation_kwargs["top_k"], 20)

    def test_structured_no_json_records_final_response_excerpt(self) -> None:
        advisor = ModelAdvisor()
        result = advisor._parse_json_completion("plain response without braces", {"type": "object"})

        self.assertIsNone(result)
        self.assertEqual(advisor.last_call_status, "no_json")
        self.assertIn("plain response without braces", advisor.last_call_detail)

    def test_qwen_fp8_skip_repair_does_not_shadow_gate_projection(self) -> None:
        quantization = SimpleNamespace(
            modules_to_not_convert=[
                "model.language_model.layers.0.mlp.gate",
                "model.language_model.layers.0.input_layernorm",
                "lm_head",
            ]
        )
        config = SimpleNamespace(quantization_config=quantization)

        self.assertEqual(_repair_qwen_fp8_skip_patterns(config), 1)
        self.assertEqual(
            quantization.modules_to_not_convert,
            ["model.language_model.layers.0.input_layernorm", "lm_head"],
        )

    def test_unscaled_fp8_linear_integrity_check(self) -> None:
        class Module:
            def __init__(self, *, scaled: bool) -> None:
                self.weight = SimpleNamespace(dtype="torch.float8_e4m3fn")
                if scaled:
                    self.weight_scale_inv = object()

        model = SimpleNamespace(
            named_modules=lambda: [
                ("scaled", Module(scaled=True)),
                ("broken", Module(scaled=False)),
            ]
        )

        self.assertEqual(_unscaled_fp8_linear_names(model), ["broken"])

    def test_shared_runtime_is_reused_by_multiple_advisors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            key = (str(os.path.realpath(tmp)), "bf16")
            processor = object()
            model = object()
            ModelAdvisor._shared_runtimes[key] = (processor, model, 3.5)
            first = ModelAdvisor(model_path=tmp)
            second = ModelAdvisor(model_path=tmp)

            self.assertTrue(first.load())
            self.assertTrue(second.load())
            self.assertIs(first.model, second.model)
            self.assertEqual(second.load_seconds, 3.5)

    def test_cuda_load_uses_bf16_sdpa_and_cuda_only_device_map(self) -> None:
        os.environ["OURO_ARC_MODEL_REQUIRE_CUDA"] = "1"
        os.environ["OURO_ARC_MODEL_DTYPE"] = "bf16"
        torch_module = types.ModuleType("torch")
        torch_module.bfloat16 = object()  # type: ignore[attr-defined]
        torch_module.float16 = object()  # type: ignore[attr-defined]
        torch_module.float32 = object()  # type: ignore[attr-defined]
        torch_module.cuda = types.SimpleNamespace(is_available=lambda: True)  # type: ignore[attr-defined]
        transformers_module = types.ModuleType("transformers")
        captured: dict[str, object] = {}

        class ProcessorFactory:
            @staticmethod
            def from_pretrained(path: str, **kwargs: object) -> object:
                return object()

        class LoadedModel:
            def eval(self) -> None:
                captured["eval"] = True

        class ModelFactory:
            @staticmethod
            def from_pretrained(path: str, **kwargs: object) -> object:
                captured.update(kwargs)
                return LoadedModel()

        transformers_module.AutoProcessor = ProcessorFactory  # type: ignore[attr-defined]
        transformers_module.AutoModelForMultimodalLM = ModelFactory  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            sys.modules,
            {"torch": torch_module, "transformers": transformers_module},
        ):
            advisor = ModelAdvisor(model_path=tmp, require_model=True)
            self.assertTrue(advisor.load())

        self.assertEqual(captured["device_map"], {"": "cuda:0"})
        self.assertEqual(captured["attn_implementation"], "sdpa")
        self.assertTrue(captured["low_cpu_mem_usage"])
        self.assertIs(captured["dtype"], torch_module.bfloat16)  # type: ignore[attr-defined]
        self.assertTrue(captured["eval"])

    def test_structured_completion_uses_schema_and_ignores_thinking_field(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ["OURO_ARC_MODEL_THINK"] = "1"
        captured: list[dict[str, object]] = []
        schema = {
            "type": "object",
            "properties": {"model_source": {"type": "string"}},
            "required": ["model_source"],
        }

        def fake_urlopen(request: object, timeout: float):
            payload = json.loads(request.data.decode("utf-8"))  # type: ignore[attr-defined]
            captured.append(payload)
            return FakeResponse(
                {
                    "message": {
                        "thinking": '{"model_source":"bad"}',
                        "content": '{"model_source":"def step(): pass"}',
                    }
                }
            )

        advisor = ModelAdvisor()
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            result = advisor.complete_json(
                "author model",
                schema,
                image=b"png",
                purpose="world-model-physicist",
                max_new_tokens=256,
            )

        self.assertEqual(result, {"model_source": "def step(): pass"})
        self.assertEqual(captured[0]["format"], "json")
        self.assertTrue(captured[0]["think"])
        self.assertEqual(captured[0]["options"]["num_predict"], 512)  # type: ignore[index]
        self.assertEqual(captured[0]["messages"][1]["images"], ["cG5n"])  # type: ignore[index]
        self.assertEqual(advisor.call_records[0]["purpose"], "world-model-physicist")

    def test_structured_thinking_reserves_separate_reasoning_tokens(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        os.environ["OURO_ARC_MODEL_THINK"] = "1"
        captured: list[dict[str, object]] = []

        def fake_urlopen(request: object, timeout: float):
            captured.append(json.loads(request.data.decode("utf-8")))  # type: ignore[attr-defined]
            return FakeResponse({"message": {"content": "{}"}})

        advisor = ModelAdvisor()
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            result = advisor.complete_json(
                "prompt",
                {"type": "object"},
                max_new_tokens=4096,
            )

        self.assertEqual(result, {})
        self.assertEqual(captured[0]["options"]["num_predict"], 8192)  # type: ignore[index]

    def test_structured_completion_rejects_reasoning_without_final_json(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"

        def fake_urlopen(request: object, timeout: float):
            return FakeResponse({"message": {"thinking": "private", "content": ""}})

        advisor = ModelAdvisor()
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            result = advisor.complete_json("prompt", {"type": "object"})
        self.assertIsNone(result)
        self.assertEqual(advisor.last_call_status, "empty_content")

    def test_structured_completion_repairs_qwen_code_only_object(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        source = (
            "def parse_observation(grid, memory):\n    return grid\n"
            "def available_actions(state):\n    return []\n"
            "def step(state, action):\n    return state\n"
            "def render(state):\n    return state\n"
            "def is_goal(state):\n    return False\n"
            "def canonicalize(state):\n    return state"
        )
        malformed = '{"' + source + '"}'

        def fake_urlopen(request: object, timeout: float):
            return FakeResponse({"message": {"content": malformed}})

        advisor = ModelAdvisor()
        schema = {
            "type": "object",
            "properties": {"model_source": {"type": "string"}},
        }
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            result = advisor.complete_json("prompt", schema)
        self.assertIn("def parse_observation", result["model_source"])
        self.assertTrue(advisor.last_call_repaired)

    def test_structured_completion_repairs_repeated_model_source_loop(self) -> None:
        os.environ["OURO_ARC_MODEL_BACKEND"] = "ollama"
        source = "def parse_observation(grid, memory):\n    return grid\ndef step(state, action):\n    return state"
        encoded = json.dumps(source)
        malformed = '{"model_source":' + encoded + ',"model_source":' + encoded

        def fake_urlopen(request: object, timeout: float):
            return FakeResponse({"message": {"content": malformed}})

        advisor = ModelAdvisor()
        schema = {
            "type": "object",
            "properties": {
                "model_source": {"type": "string"},
                "notes": {"type": "string"},
                "experiment": {"type": ["object", "null"]},
                "helpers": {"type": "array"},
            },
            "required": ["model_source", "notes", "experiment", "helpers"],
            "additionalProperties": False,
        }
        with patch("ouro_arc.advisor.urllib.request.urlopen", fake_urlopen):
            result = advisor.complete_json("prompt", schema)
        self.assertEqual(result["model_source"], source)
        self.assertIsNone(result["experiment"])
        self.assertTrue(advisor.last_call_repaired)


class FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        import json

        return json.dumps(self.payload).encode("utf-8")


class RecordingTensor:
    def to(self, device: object) -> "RecordingTensor":
        return self


class RecordingProcessor:
    def __init__(self) -> None:
        self.images: list[object] | None = None
        self.messages: list[dict[str, object]] | None = None
        self.template_kwargs: dict[str, object] = {}

    def apply_chat_template(self, *args: object, **kwargs: object) -> str:
        self.messages = args[0]  # type: ignore[assignment]
        self.template_kwargs = dict(kwargs)
        return "chat text"

    def __call__(self, **kwargs: object) -> dict[str, RecordingTensor]:
        self.images = kwargs["images"]  # type: ignore[assignment]
        return {"input_ids": RecordingTensor()}

    def decode(self, output: object, skip_special_tokens: bool = True) -> str:
        return '{"mode":"probe","actions":[{"action":1}],"hypothesis":"ok","confidence":1}'


class ThinkingProcessor(RecordingProcessor):
    def decode(self, tokens: object, skip_special_tokens: bool = False) -> str:
        return (
            '<think>{"mode":"probe","actions":[{"action":9}]}</think>'
            '{"mode":"probe","actions":[{"action":1}],'
            '"hypothesis":"final json","confidence":1}'
        )

class RecordingModel:
    device = "cpu"

    def __init__(self) -> None:
        self.max_new_tokens = 0
        self.generation_kwargs: dict[str, object] = {}

    def generate(self, **kwargs: object) -> list[str]:
        self.generation_kwargs = dict(kwargs)
        self.max_new_tokens = int(kwargs["max_new_tokens"])
        return ["tokens"]


class ShapedInputIds:
    shape = (1, 2)

    def to(self, device: object) -> "ShapedInputIds":
        return self


class SlicingProcessor:
    def __init__(self) -> None:
        self.decoded_tokens: object = None

    def apply_chat_template(self, *args: object, **kwargs: object) -> dict[str, object]:
        return {"input_ids": ShapedInputIds()}

    def decode(self, output: object, skip_special_tokens: bool = False) -> str:
        self.decoded_tokens = output
        return "<think>private reasoning with bad JSON</think>assistant output"

    def parse_response(self, response: str) -> list[dict[str, str]]:
        return [
            {"thinking": "private reasoning"},
            {
                "content": '{"mode":"probe","actions":[{"action":1}],'
                '"hypothesis":"final only","confidence":1}'
            },
        ]


class SlicingModel:
    device = "cpu"

    def generate(self, **kwargs: object) -> list[list[str]]:
        return [["prompt-1", "prompt-2", "generated-json"]]


class ConcurrentRecordingModel(RecordingModel):
    def __init__(self) -> None:
        super().__init__()
        self.concurrent = 0
        self.max_concurrent = 0
        self.lock = threading.Lock()

    def generate(self, **kwargs: object) -> list[str]:
        with self.lock:
            self.concurrent += 1
            self.max_concurrent = max(self.max_concurrent, self.concurrent)
        time.sleep(0.02)
        with self.lock:
            self.concurrent -= 1
        return super().generate(**kwargs)


if __name__ == "__main__":
    unittest.main()
