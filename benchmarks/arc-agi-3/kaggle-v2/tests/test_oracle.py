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
