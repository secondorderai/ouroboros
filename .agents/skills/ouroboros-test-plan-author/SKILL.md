---
name: ouroboros-test-plan-author
description: Create intent-based Ouroboros desktop E2E Markdown test plans from a high-level goal, feature, module, bug, PRD, ticket, or UI area. Use when asked to generate, draft, author, improve, or expand files under test-plan/ for Agent Browser desktop testing.
---

# Ouroboros Test Plan Author

Use this skill to turn a high-level feature, module, bug, or goal into one or
more executable Markdown charters under `test-plan/`.

## Workflow

1. Ground the plan in the repo before writing:
   - Search relevant renderer components, stores, protocol types, existing E2E specs, and existing `test-plan/*.md`.
   - Prefer current labels, UI names, domain language, and mock data patterns from the codebase.
2. Decide plan granularity:
   - One plan for one user-centered workflow.
   - Split broad modules into multiple charters only when the workflows have different setup, risks, or pass/fail oracles.
3. Write the Markdown plan in `test-plan/<kebab-case-name>.md`.
4. Keep the plan intent-based:
   - Describe what the user is trying to accomplish.
   - Avoid brittle CSS selectors, implementation details, or Playwright-style commands.
   - Include enough observable outcomes for an Agent Browser runner to judge pass/fail.
5. If the plan needs mock data, name the required scenario shape in plain language.
   - Do not invent large fixture JSON unless the user explicitly asks for it.
   - State when missing mock data should produce `INCONCLUSIVE`.

## Required Plan Shape

```md
# Title Case Plan Name

## Mission

One or two sentences describing the user workflow and why it matters.

## Priority / Tags

p0, smoke, desktop, feature-name

## Initial State

- Fresh Electron user data directory, unless persistence is the subject.
- Mock CLI scenario requirements.
- Any required workspace, dialog response, policy response, or seeded data.

## Intent Steps

1. User-centered action.
2. Observable action or navigation.
3. Verification step.

## Expected Outcomes

- Concrete visible UI state.
- Relevant persisted/logged behavior when observable through test logs.
- Recovery or closing behavior where appropriate.
- No uncaught renderer error.

## Evidence Required

- Screenshot names or moments worth capturing.
- Console and page error output.
- Any mock CLI log evidence worth checking.
```

## Quality Bar

- Use `p0` for release-blocking smoke flows; use `p1` for important surfaces; use `p2` for edge cases and exploratory coverage.
- Make each expected outcome externally observable from the running app, screenshots, logs, or console output.
- Prefer stable human-facing terms: accessible labels, menu names, panel titles, visible messages.
- Include negative or recovery checks for risky flows: cancellation, empty states, disabled actions, denied approvals, failed config, or restart.
- Keep each plan short enough for an agent to execute in one focused run.

## Output

After writing or updating a plan, report:

- The file path.
- The workflow covered.
- Any mock scenario assumptions.
- The exact command to dry-run and execute it:
  - `bun run test:intent:e2e -- test-plan/<name>.md --dry-run`
  - `bun run test:intent:e2e -- test-plan/<name>.md`
