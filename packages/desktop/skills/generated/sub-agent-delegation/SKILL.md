---
name: sub-agent-delegation
description: Orchestrates the dynamic spawning of isolated sub-agents to
  decompose and execute complex workflows in parallel or sequentially. Enforces
  least-privilege tool scoping, strict iteration limits, and automatic output
  summarization to prevent parent context window pollution. Handles graceful
  merging of results, timeout detection, and fault containment. Activate when a
  primary task contains clearly separable subtasks that can run independently,
  when concurrent execution is needed to reduce overall latency, when tool
  access must be strictly scoped for security or safety, or when preserving the
  parent agent's context window is critical for long-running operations. Ideal
  for multi-step data processing, parallel research tasks, modular code
  generation, and fault-tolerant workflow orchestration where context isolation
  and summarized feedback loops are required.
license: Apache-2.0
metadata:
  author: ouroboros-rsi
  version: "1.0"
  generated: "true"
  confidence: 0.9
  source_task: Design proposal for a tiered sub-agent spawning architecture to
    enable task delegation, context isolation, tool scoping, and parallel
    execution.
  source_sessions: []
  source_observations: []
  source_timestamps: []
---

## Sub-Agent Delegation Protocol

This skill enables a parent agent to safely delegate complex workloads to isolated sub-agents. It enforces strict boundaries on tool access, execution limits, and context propagation to maximize reliability and prevent context window exhaustion.

### 1. Decompose & Identify Delegable Subtasks
- Analyze the parent task for logical boundaries.
- Flag subtasks that are:
  - Independent (no strict sequential dependency)
  - High-context or computationally heavy
  - Requiring specialized or restricted tool access
- Format delegation requests as discrete, self-contained units.

### 2. Scope Tools via Least-Privilege Allowlist
- Map required tools per subtask.
- Explicitly define a `tool_allowlist` for the sub-agent. Exclude parent-level tools not strictly needed.
- Document denied tools and fallback behaviors.

### 3. Spawn with Strict Constraints
Initialize the sub-agent using the following template:
