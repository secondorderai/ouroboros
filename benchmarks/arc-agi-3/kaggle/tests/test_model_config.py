from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from ouro_arc.model_config import (
    apply_qwen_config,
    behavioral_contract,
    load_qwen_config,
    model_env,
)
from ouro_arc.advisor import advisor_contract_hashes


class ModelConfigTest(unittest.TestCase):
    def test_model_neutral_setting_precedes_legacy_alias(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OURO_ARC_MODEL_THINK": "0",
                "OURO_ARC_GEMMA_THINK": "1",
            },
            clear=False,
        ):
            self.assertEqual(model_env("THINK"), "0")

    def test_legacy_alias_remains_supported(self) -> None:
        with patch.dict(os.environ, {"OURO_ARC_GEMMA_POLICY": "hypothesis"}, clear=True):
            self.assertEqual(model_env("POLICY"), "hypothesis")

    def test_local_and_kaggle_share_behavioral_contract(self) -> None:
        config = load_qwen_config()
        expected = behavioral_contract(config)
        with patch.dict(os.environ, {}, clear=True):
            apply_qwen_config(config, backend="ollama", overwrite=True)
            local = {key: model_env(name) for key, name in (
                ("policy", "POLICY"),
                ("think", "THINK"),
                ("max_calls", "MAX_CALLS"),
                ("max_new_tokens", "MAX_NEW_TOKENS"),
            )}
            apply_qwen_config(config, backend="transformers", overwrite=True)
            kaggle = {key: model_env(name) for key, name in (
                ("policy", "POLICY"),
                ("think", "THINK"),
                ("max_calls", "MAX_CALLS"),
                ("max_new_tokens", "MAX_NEW_TOKENS"),
            )}
        self.assertEqual(local, kaggle)
        self.assertEqual(local["policy"], expected["policy"])
        self.assertEqual(int(local["max_new_tokens"]), expected["max_new_tokens"])

    def test_local_and_kaggle_contract_hashes_match(self) -> None:
        config = load_qwen_config()
        prompt = "h-a1-xn-yn: first\nh-a2-xn-yn: second"
        image = b"deterministic-png"
        with patch.dict(os.environ, {}, clear=True):
            apply_qwen_config(config, backend="ollama", overwrite=True)
            local = advisor_contract_hashes(prompt, image)
            apply_qwen_config(config, backend="transformers", overwrite=True)
            kaggle = advisor_contract_hashes(prompt, image)
        self.assertEqual(local, kaggle)
        self.assertEqual(set(local), {"prompt", "image", "schema", "generation"})


if __name__ == "__main__":
    unittest.main()
