"""ouro2 — from-scratch minimal ARC-AGI-3 Kaggle agent.

CPU induces mechanic rules from exact transition diffs; rules are data run
by a fixed interpreter; an optional LLM answers multiple-choice questions;
planning happens inside the induced model before real actions are spent.
"""
from .config import Config
from .timeline import ActionSpec, Timeline, Transition

__all__ = ["ActionSpec", "Config", "Timeline", "Transition"]
