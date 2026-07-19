from ouro2.config import Config
from ouro2.oracle import Oracle


def make(transport, max_calls=5):
    cfg = Config(disable_model=False, model_max_calls=max_calls)
    return Oracle(cfg, transport=transport)


def test_valid_choice_accepted():
    o = make(lambda p: '{"choice": "b"}')
    assert o.select("RULE_SELECT", "pick", ["a", "b", "c"], default="a") == "b"
    assert o.calls_used == 1 and o.failures == 0


def test_malformed_json_falls_back_to_default():
    o = make(lambda p: "I think the answer is b, probably?")
    assert o.select("RULE_SELECT", "pick", ["a", "b"], default="a") == "a"
    assert o.failures == 1


def test_out_of_menu_choice_rejected():
    o = make(lambda p: '{"choice": "zebra"}')
    assert o.select("GOAL_SELECT", "pick", ["a", "b"], default="b") == "b"
    assert o.failures == 1


def test_transport_exception_fails_open():
    def boom(prompt):
        raise RuntimeError("connection refused")

    o = make(boom)
    assert o.select("EXPERIMENT_SELECT", "pick", ["a", "b"], default="a") == "a"


def test_call_cap_enforced():
    o = make(lambda p: '{"choice": "b"}', max_calls=1)
    assert o.select("RULE_SELECT", "q", ["a", "b"], default="a") == "b"
    # Cap reached: no more transport calls, defaults only.
    assert o.select("RULE_SELECT", "q", ["a", "b"], default="a") == "a"
    assert o.calls_used == 1


def test_single_choice_short_circuits():
    calls = []
    o = make(lambda p: calls.append(p) or '{"choice": "a"}')
    assert o.select("RULE_SELECT", "q", ["a"], default="a") == "a"
    assert not calls  # no LLM call for a trivial menu


def test_transformers_load_failure_latches_after_one_attempt():
    # Bad model path: from_pretrained (or the transformers import itself)
    # raises on the first call. The latch must record the failure and skip
    # the ~20s retry on every later call, still failing open to the default.
    cfg = Config(
        disable_model=False,
        model_backend="transformers",
        model_path="/nonexistent/model",
        model_max_calls=5,
    )
    o = Oracle(cfg)
    assert o.select("RULE_SELECT", "q", ["a", "b"], default="a") == "a"
    assert o.select("RULE_SELECT", "q", ["a", "b"], default="a") == "a"
    assert o.failures == 2
    assert o._load_failed is True
    assert o._load_attempts == 1  # second call latched, no reload attempt


def test_thinking_block_is_stripped_before_json_scan():
    # A thinking model reasons (with stray braces!) before answering; only
    # the post-</think> text is the answer.
    o = make(
        lambda p: '<think>Options {a, b}... weighing {"choice": "a"}? No.</think>\n'
        '{"choice": "b"}'
    )
    assert o.select("RULE_SELECT", "pick", ["a", "b"], default="a") == "b"
    assert o.failures == 0


def test_thinking_config_from_env(monkeypatch):
    monkeypatch.setenv("OURO2_MODEL_THINKING", "1")
    assert Config.from_env().model_thinking is True
    monkeypatch.delenv("OURO2_MODEL_THINKING")
    assert Config.from_env().model_thinking is False
