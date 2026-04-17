---
name: proactive-context-management
description: Implements a proactive, threshold-driven context window management
  system that estimates token usage across components, compares against a
  centralized budget, and triggers graduated responses (warn, flush, compact)
  before externalizing conversational state into structured checkpoints.
  Truncates raw history only after state preservation using greedy semantic
  packing, and provides emergency recovery for length-limit failures via partial
  output capture and aggressive compaction. Activate when designing or
  refactoring LLM agent architectures that require bounded context windows,
  dynamic memory management, or long-running conversational state preservation.
  Specifically trigger when implementing automated context trimming, tiered
  token budgeting, checkpoint-based memory systems, or fallback recovery
  mechanisms for generative AI pipelines facing context overflow.
license: Apache-2.0
metadata:
  author: ouroboros-rsi
  version: "1.0"
  generated: "true"
  confidence: 0.9
  source_task: Analyzed and documented a multi-layered, threshold-based context
    token management system that externalizes conversational state into
    structured checkpoints before truncating raw history.
  source_sessions: []
  source_observations: []
  source_timestamps: []
---

## Core Architecture & Workflow

This skill implements a deterministic, state-preserving context management pipeline. It operates on a strict "measure → decide → externalize → trim → recover" sequence to prevent semantic loss during context window compression.

### Step 1: Centralized Configuration Setup
Define all parameters in a single configuration object to ensure consistency:
- `token_budget`: Maximum allowed context size in tokens.
- `thresholds`: `{ warn: 0.75, flush: 0.85, compact: 0.95 }` (ratios of budget).
- `retention`: Minimum fraction of semantic blocks to preserve during compaction (e.g., `0.4`).
- `checkpoint_schema`: JSON structure defining how conversational state is serialized.

### Step 2: Token Estimation & Threshold Evaluation
1. Apply a consistent token heuristic across all context components (system prompts, user messages, tool outputs, attached files).
2. Calculate `usage_ratio = estimated_tokens / token_budget`.
3. Evaluate `usage_ratio` against tiered thresholds to determine the required action level.

### Step 3: Execute Graduated Triggers
- **Warn (`≥ warn`):** Log usage metrics and flag upcoming compaction for monitoring.
- **Flush (`≥ flush`):** Clear transient data (temporary tool outputs, scratchpad variables) to reclaim budget without losing core state.
- **Compact (`≥ compact`):** Initiate full state externalization and aggressive history reduction.

### Step 4: Externalize State (Pre-Trim)
**CRITICAL:** Never truncate raw history before capturing state.
1. Parse recent conversation turns for actionable insights, decisions, pending tasks, and resolved constraints.
2. Serialize findings into a structured checkpoint matching `checkpoint_schema`.
3. Persist the checkpoint to the external memory layer or vector store.

### Step 5: Greedy Semantic Trimming
1. Rank historical messages by semantic weight and recency.
2. Use greedy packing: accumulate highest-weight blocks until the remaining space fits `token_budget * retention`.
3. Discard lowest-weight raw history blocks.
4. Inject the newly created checkpoint at the top of the trimmed context window.

### Step 6: Emergency Recovery (Length-Limit Failures)
If the LLM API rejects the prompt due to hard length limits:
1. Catch the error and isolate any partial output/response.
2. Aggressively compact: drop all but the last 3 turns, the latest checkpoint, and the core system prompt.
3. Reconstruct the payload with strict byte/token caps.
4. Retry with exponential backoff. Log failure metrics for threshold tuning.

## Input/Output Examples

**Input Payload:**
