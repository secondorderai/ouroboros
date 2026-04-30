---
name: ou-features-audit
description: "Audit implemented Ouroboros features against requirements, PRDs, tickets, GitHub issues, or acceptance criteria to find missing, partial, incorrect, or unverifiable work. Use when the user asks to audit a feature, verify implementation completeness, compare code to requirements, check acceptance criteria, run a gap analysis, determine what is left to build, check whether a ticket is done, audit against a PRD/spec, or asks whether recent work in the Ouroboros codebase matches its requirements. Do NOT use for creating PRDs, generating tickets, implementing tickets, broad full-codebase review, or general bug triage."
---

# Ouroboros Features Audit

Audit the Ouroboros codebase against feature requirements and acceptance criteria. Produce a structured gap analysis showing what passed, what failed, what is partial, and what cannot be verified from code alone.

Return the report in the conversation unless the user explicitly asks for a file.

## 1. Gather Requirements

Try sources in this order, stopping at the first useful source.

### GitHub Issue

If the user provides an issue URL or number, fetch it with the current repository remote:

```bash
gh issue view <number> --json number,title,body,state,labels
```

If the repository supports sub-issues, also check:

```bash
gh api repos/<owner>/<repo>/issues/<number>/sub_issues
```

Fetch sub-issue bodies when present; they often contain the actionable acceptance criteria.

### Local Markdown

Check these locations:

1. Any file explicitly named by the user.
2. `PRD.md` in the current working directory.
3. Markdown files in `tickets/`.
4. Nearby `ticket-*.md` or `prd-*.md` files.

If both `PRD.md` and `tickets/` exist, treat tickets as the source of truth for "done" and use the PRD for context.

### Conversation Context

If the requirements were just discussed in the conversation, extract criteria from that context and state what you are auditing against before proceeding.

### Missing Source

If no requirements source is available, ask for a GitHub issue number, ticket path, PRD path, or pasted criteria.

## 2. Extract Testable Criteria

Transform the source into a flat list of falsifiable criteria grouped by category.

From structured tickets, extract every checkbox under `Acceptance Criteria`, `Feature Tests`, `Requirements`, and similar sections. Audit checked and unchecked boxes; a checked box is only a claim, not proof.

From prose, extract concrete statements:

- Data model: new types, fields, persistence, transcript records, config shape.
- CLI behavior: commands, agent loop behavior, tool contracts, config loading.
- Tools: tool name, schema, permissions, execution behavior, Result contract.
- JSON-RPC: request methods, notifications, protocol types, handlers.
- Desktop UI: renderer components, Zustand stores, IPC handling, visible states.
- Permissions and safety: approval gates, read-only restrictions, leases, worktree isolation.
- Tests: unit, integration, and E2E coverage required by `AGENTS.md`.

Always add relevant implicit Ouroboros criteria:

- New CLI tools export `name`, `description`, JSON Schema `schema`, and async `execute`.
- Tool execution follows local Result/error-handling conventions where the surrounding code expects them.
- New or renamed RPC methods update `RPC_METHOD_NAMES` and pass protocol contract tests.
- New notification types update `NOTIFICATION_METHOD_NAMES` and pass protocol contract tests.
- CLI feature changes include Bun tests in the matching `packages/cli/tests/` area.
- Desktop user-visible changes include Playwright E2E tests in `packages/desktop/tests/e2e/`.
- Shared type changes are exercised from at least one consuming package.
- Runtime behavior stays in the CLI; desktop remains presentation/IPC.
- Renderer code uses typed preload APIs and existing stores/components.
- Colors and component styling follow `packages/desktop/DESIGN.md` and CSS variable conventions.

Before deep investigation, briefly present the criteria list grouped by category and say you are proceeding with the audit.

## 3. Audit the Codebase

Use `rg`, `rg --files`, targeted file reads, and existing tests to verify each criterion. Prefer code evidence over assumptions.

If the user explicitly asked for parallel agent work and the harness permits it, split independent categories across up to three explore agents. Otherwise audit locally.

### Ouroboros Investigation Map

Use these paths as the default search surface:

| Category | Primary paths |
|---|---|
| CLI agent loop | `packages/cli/src/agent.ts`, `packages/cli/src/cli/`, `packages/cli/src/llm/` |
| CLI tools | `packages/cli/src/tools/`, `packages/cli/tests/tools/` |
| Config and permissions | `packages/cli/src/config.ts`, `packages/cli/src/*permission*`, related tests |
| Persistence | `packages/cli/src/memory/`, `packages/cli/tests/memory/` |
| JSON-RPC | `packages/cli/src/json-rpc/`, `packages/desktop/src/shared/protocol.ts`, integration tests |
| Desktop main/IPC | `packages/desktop/src/main/`, `packages/desktop/src/preload/`, E2E tests |
| Desktop renderer | `packages/desktop/src/renderer/`, stores, hooks, components, views |
| Shared types | `packages/shared/src/`, package consumers |
| Team/subagent features | `packages/cli/src/team/`, `spawn-agent`, `subagent`, `worker`, `permission-lease` files |
| Tests | `packages/cli/tests/`, `packages/desktop/tests/`, `bun run verify` output when available |

### Status Rules

Assign one status per criterion:

| Status | Meaning |
|---|---|
| PASS | Fully implemented and matches the requirement. Cite code/test evidence. |
| FAIL | Missing or implemented incorrectly. State expected vs. actual. |
| PARTIAL | Some required behavior exists but important pieces are missing or mismatched. |
| NOT VERIFIABLE | Code alone cannot prove it; state the manual or runtime check needed. |

Flag any source checkbox marked done when the implementation does not actually satisfy it.

## 4. Report

Use this structure:

```markdown
# Feature Audit: [Feature Name]

**Source:** [issue/ticket/PRD/conversation]
**Date:** [YYYY-MM-DD]
**Scope:** Codebase audit only unless otherwise stated

## Summary

| Status | Count |
|---|---:|
| PASS | N |
| FAIL | N |
| PARTIAL | N |
| NOT VERIFIABLE | N |
| **Total** | **N** |

**Overall assessment:** [One sentence.]

## Findings by Category

### [Category]

| # | Criterion | Status | Evidence / Gap |
|---:|---|---|---|
| 1 | [criterion] | PASS | `[file]` implements ..., `[test]` covers ... |
| 2 | [criterion] | FAIL | Expected ..., but no matching implementation found in ... |

## Action Items

1. **[FAIL/PARTIAL] [Short title]** - What to build or fix, which files to inspect or modify, and what test should prove it.

## Notes

[Caveats, runtime checks needed, stale ticket flags, or verification commands.]
```

Keep evidence concrete. Include file paths and function/component names. For gaps, name the likely owner files and the regression test that should be added.
