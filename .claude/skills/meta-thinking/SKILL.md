---
name: meta-thinking
description: Use this skill when the user needs structured planning, complex analysis, difficult tradeoff decisions, or troubleshooting under uncertainty and the agent should apply a compact meta-thinking loop with task classification, a meta-mode gate, plan extraction, critique, and concise trust signals. Prefer it when surfacing confidence, limitations, and context gaps will materially improve the answer. Do not use it for simple factual or one-step requests where extra framing would add friction without improving the result.
metadata:
  short-description: Apply the SecondOrder meta-thinking workflow
---

# Meta Thinking

Use this skill to apply the SecondOrder method to the agent's own work. This is an execution skill, not a teaching curriculum.

## Activation

Use this skill when the request benefits from one or more of:

- structured planning before answering
- tradeoff analysis or decision support
- troubleshooting with missing or unreliable context
- explicit handling of uncertainty, limitations, or context gaps
- reflective response shaping instead of a direct one-pass answer

Do not use the full workflow for:

- simple factual lookup
- short transformations or edits with obvious steps
- routine requests where standard tooling is sufficient and visible framing would add noise

## Default Workflow

1. Classify the task.
2. Decide whether meta mode is warranted.
3. Extract the goal, constraints, and response strategy.
4. Produce a compact plan.
5. Critique the draft for weak assumptions, limitations, and missing context.
6. Return the answer with concise visible framing when justified.

Treat this as a compact control loop, not an excuse to dump internal reasoning.

## Output Contract

When meta mode is justified, bias toward a compact response structure that can include:

- `goal`
- `constraints`
- `plan`
- `confidence`
- `limitations`
- `context_gaps`
- `response_strategy` when it helps the answer land cleanly

Only surface fields that materially help the user. Omit empty sections. Keep the framing short enough that the answer still feels direct.

For response shapes by task type, read [references/output-patterns.md](references/output-patterns.md).

## Critique Pass

Before finalizing, check for:

- missing constraints
- unsupported assumptions
- plan steps that are too broad or too brittle
- uncertainty that should be made explicit
- context gaps that, if resolved, would change the answer materially

If the critique finds meaningful issues, tighten the answer and surface only the user-relevant residue.

## Stop Conditions

De-escalate to a direct answer when:

- the task is low complexity
- the plan adds no meaningful value
- the critique produces no user-relevant caution
- visible meta framing would be longer than the useful content

## Anti-goals

- Do not reveal chain-of-thought or hidden scratch work.
- Do not force every answer into a verbose template.
- Do not use this as a generic "think harder" wrapper.
- Do not turn the task into a lesson on metacognition unless the user asks for that.

## References

- Read [references/second-order-method.md](references/second-order-method.md) for the canonical method, terminology, and gating heuristics.
- Read [references/output-patterns.md](references/output-patterns.md) for compact response patterns by task type.
- Read [references/examples.md](references/examples.md) for realistic trigger and non-trigger examples.
