---
name: ou-full-code-review
description: >
  Perform a comprehensive full-codebase code review using specialized parallel agents.
  Use this skill whenever the user asks for a "full code review", "codebase review",
  "review everything", "audit the code", "code health check", or any request to
  review the entire project (not just a PR or single file). Also trigger when the user
  says things like "what's wrong with this codebase", "find all the issues",
  "review all my code", or "comprehensive review". This is specifically for
  whole-codebase analysis, not single-file or PR-scoped reviews.
---

# Full Codebase Review

Run a comprehensive, multi-dimensional code review across the entire codebase by
dispatching specialized review agents in parallel. Each agent focuses on a different
quality dimension, and their findings are synthesized into a unified report.

## Why parallel agents?

A single-pass review misses things. Silent failures hide in catch blocks. Type designs
erode over time. Comments drift from the code they describe. Tests cover happy paths
but miss edges. By running six focused reviewers simultaneously, each with a specific
lens, you get deeper coverage faster than a sequential review ever could.

## Review Dimensions

Each agent targets a specific quality concern:

| Agent | Focus | What it catches |
|-------|-------|----------------|
| **silent-failure-hunter** | Error handling integrity | Swallowed exceptions, empty catch blocks, fallbacks that mask real errors, inadequate error propagation |
| **code-reviewer** | Standards & conventions | Style violations, anti-patterns, deviations from CLAUDE.md conventions, potential bugs |
| **type-design-analyzer** | Type system quality | Weak encapsulation, missing invariants, overly permissive types, stringly-typed interfaces |
| **comment-analyzer** | Documentation accuracy | Stale comments, misleading docstrings, comment rot, missing docs on complex logic |
| **code-simplifier** | Code clarity | Unnecessary complexity, dead code, over-abstraction, opportunities to simplify |
| **pr-test-analyzer** | Test coverage gaps | Missing edge case tests, untested error paths, inadequate assertion quality |

## Execution Steps

### 1. Identify scope

Before dispatching agents, understand what you're reviewing:

- Read the project's CLAUDE.md for conventions and standards the agents should check against
- Run `git diff --stat` to understand recent changes (agents can weight recent code higher)
- Get a file listing of the source directories to determine the review surface

For the ouroboros project specifically, the key source directories are:
- `src/` — all production TypeScript code
- `tests/` — test suite

### 2. Dispatch all six agents in parallel

Spawn each agent using the Agent tool with the appropriate `subagent_type` from
`pr-review-toolkit`. Launch ALL SIX in a single message to maximize parallelism.

Each agent needs a clear prompt that includes:
- The project root path
- Which files/directories to focus on (typically `src/` for production code)
- The project conventions (from CLAUDE.md) — especially the Result<T, Error> pattern,
  Zod validation, tool interface contract, and "never throw" rule
- What to report: file path, line number, severity (critical/warning/info), description

**Prompt template for each agent:**

```
Review the codebase at [project-root] for [agent's focus area].

Project conventions (from CLAUDE.md):
- TypeScript on Bun runtime
- All tools export: name, description, schema (JSON Schema), execute (async fn)
- Error handling: all tools return Result<T, Error> — never throw
- Use Zod for runtime type validation
- Prefer composition over inheritance
- Skills conform to agentskills.io spec

Focus on the src/ directory. For each finding, report:
- File path and line number
- Severity: critical / warning / info
- Clear description of the issue
- Suggested fix (brief)

Be selective — report only genuine issues, not style nitpicks. Prioritize
findings that could cause bugs, data loss, or maintenance headaches.
```

Adapt the focus instruction per agent:
- **silent-failure-hunter**: "identify silent failures, swallowed errors, empty catch blocks, try/catch that logs but doesn't propagate, and fallback behavior that could mask real problems"
- **code-reviewer**: "check adherence to the project conventions listed above, identify potential bugs, logic errors, and security concerns"
- **type-design-analyzer**: "analyze type definitions for encapsulation quality, invariant expression, and whether types enforce their contracts or allow invalid states"
- **comment-analyzer**: "check that comments accurately describe the code, identify stale or misleading comments, and flag complex logic that lacks explanation"
- **code-simplifier**: "identify unnecessary complexity, dead code, over-engineering, and opportunities to simplify while preserving functionality"
- **pr-test-analyzer**: "review the tests/ directory for coverage gaps, missing edge cases, untested error paths, and assertion quality"

### 3. Collect and synthesize results

As agents complete, gather their findings. Then produce a unified review report
organized by severity and file, not by agent. The user cares about "what's wrong
with my code" — not "what did agent X find."

**Report structure:**

```markdown
# Full Codebase Review — [Project Name]

## Summary
- X critical issues, Y warnings, Z informational notes
- Key themes: [2-3 sentence overview of the main patterns found]

## Critical Issues
[Issues that could cause bugs, data loss, or security problems]

### [file:line] — [short title]
**Found by:** [agent name]
[Description and suggested fix]

## Warnings
[Issues that hurt maintainability or deviate from conventions]

### [file:line] — [short title]
**Found by:** [agent name]
[Description and suggested fix]

## Informational
[Opportunities for improvement, not urgent]

### [file:line] — [short title]
**Found by:** [agent name]
[Description and suggested fix]

## Test Coverage Gaps
[Dedicated section for test findings since they're actionable separately]

## Positive Observations
[2-3 things the codebase does well — reviews shouldn't be purely negative]
```

### 4. Deduplicate and cross-reference

Multiple agents may flag the same issue from different angles. For example, a
silent-failure-hunter finding about a swallowed error and a code-reviewer finding
about a missing Result return are likely the same issue. Merge these, noting
which agents flagged it (higher confidence when multiple agents agree).

### 5. Present the report

Share the synthesized report. After presenting it, offer to:
- Fix critical issues immediately
- Create tickets/TODOs for warnings
- Dive deeper into any specific finding

## Adapting to other projects

This skill is written with ouroboros conventions in mind, but the pattern works for
any TypeScript/JavaScript project. When reviewing a different project:
- Read its CLAUDE.md or equivalent config for project-specific conventions
- Adjust the conventions section in each agent's prompt
- Adjust source directories as needed
