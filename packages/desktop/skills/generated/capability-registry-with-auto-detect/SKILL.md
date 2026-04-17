---
name: capability-registry-with-auto-detect
description: Implements a structured capability registry paired with runtime
  auto-detection and fallback routing. This pattern maps capability identifiers
  to configuration profiles, dynamically evaluates environment constraints or
  feature requirements to select the optimal provider, and chains fallback
  handlers when primary selections fail or are unavailable. Activate when
  designing systems that must dynamically route to AI models, plugins, APIs, or
  service adapters based on runtime capabilities, version constraints, or
  availability. Use when you need automated capability matching, graceful
  degradation, configuration-driven dependency selection, or when managing a
  large catalog of interchangeable features that require deterministic
  resolution without hardcoding environment-specific logic.
license: Apache-2.0
metadata:
  author: ouroboros-rsi
  version: "1.0"
  generated: "true"
  confidence: 0.85
  source_task: Implemented a model capability registry with 80+ entries and unit
    tests, then wired it into the configuration system with auto-detection and
    fallback logic.
  source_sessions: []
  source_observations: []
  source_timestamps: []
---

# Capability Registry with Auto-Detect & Fallback

This skill provides a blueprint for managing external dependencies, models, or feature sets through a centralized registry, runtime capability detection, and automatic fallback routing.

## Step 1: Define the Registry Schema
Create a structured mapping of capability identifiers to their configuration profiles. Each entry must include a unique ID, version/constraints, required features, and a loader/initializer function.
