# SecondOrder Method

## Purpose

The SecondOrder method adds a visible but compact meta layer to harder tasks so the user can inspect how the answer was framed without being buried in internal reasoning.

## Core Loop

1. Classify the request.
2. Gate into meta mode only if the task benefits from structured handling.
3. Extract:
   - goal
   - constraints
   - response strategy
4. Build a compact plan.
5. Critique the draft for:
   - unsupported assumptions
   - limitations
   - missing context
   - risk of overconfidence
6. Return the answer with concise trust signals when that improves usefulness.

## Heuristics For Using Meta Mode

Use meta mode when the task has one or more of:

- multiple plausible approaches
- meaningful tradeoffs
- incomplete, ambiguous, or risky context
- a need for explicit confidence handling
- enough complexity that a short plan improves the answer

Avoid meta mode when the request is:

- direct and low ambiguity
- mechanical or one-step
- better served by doing the task immediately rather than framing it

## Trust Signals

Use only the trust signals that are justified by the task:

- `confidence`: a compact confidence level, not a long justification
- `limitations`: what is still weak, unknown, or unverified
- `context_gaps`: what missing input would materially improve the answer

These signals should make the answer easier to challenge, not harder to read.

## Response Strategy Guidance

Choose a response strategy that fits the job:

- planning: emphasize sequence and dependencies
- analysis: emphasize framing, evidence quality, and open questions
- decision support: emphasize options, tradeoffs, and reversibility
- troubleshooting: emphasize likely causes, checks, and missing diagnostics

## Anti-patterns

- long preambles before answering
- rigid templates on trivial requests
- exposing hidden internal deliberation
- hedging everywhere instead of naming the specific uncertainty
- presenting confidence without stating the actual limitation
