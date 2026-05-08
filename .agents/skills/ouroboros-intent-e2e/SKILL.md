---
name: ouroboros-intent-e2e
description: Run Ouroboros desktop intent-based E2E test plans written in Markdown by driving the Electron app through Agent Browser over Chrome DevTools Protocol. Use when asked to execute, debug, or author natural-language desktop QA charters in test-plan/.
allowed-tools: Bash(agent-browser:*)
---

# Ouroboros Intent E2E

Use this skill to execute Markdown test plans from `test-plan/` against the real
Ouroboros Electron desktop app through Agent Browser CDP.

## Workflow

1. Read the assigned Markdown plan completely.
2. Load version-matched Agent Browser guidance:
   - `agent-browser skills get core`
   - `agent-browser skills get electron`
3. Connect to the launched app:
   - `agent-browser connect {CDP_PORT}`
4. Capture initial state:
   - `agent-browser snapshot -i`
   - `agent-browser screenshot --annotate {OUTPUT_DIR}/initial.png`
5. Execute each intent step as a user would:
   - Prefer accessible names and snapshot refs.
   - Re-run `snapshot -i` after every click, navigation, modal, menu, or render-changing action.
   - Treat all `@eN` refs as stale after UI changes.
   - Use explicit waits for expected text or UI state.
6. Before verdict, capture:
   - `agent-browser console`
   - `agent-browser errors`
   - a final annotated screenshot
7. Write `{OUTPUT_DIR}/report.md` and `{OUTPUT_DIR}/result.json`.

## Rules

- Test only the running app. Do not inspect source files while executing the plan.
- Preserve evidence. Do not delete screenshots, videos, logs, or reports.
- If the UI blocks progress, capture the blocked state and return `INCONCLUSIVE` unless a clear product failure is visible.
- If an expected outcome is contradicted by visible UI state, return `FAIL`.
- If the plan passes but console/page errors appeared, include them in the report and choose `FAIL` when they affect user-facing behavior.

## Result JSON

Write valid JSON with this shape:

```json
{
  "verdict": "PASS",
  "summary": "Short outcome.",
  "checks": [
    {
      "name": "Onboarding completed",
      "status": "PASS",
      "evidence": ["after-onboarding.png"]
    }
  ],
  "bugs": [],
  "artifacts": ["initial.png", "final.png", "report.md"],
  "consoleErrors": []
}
```

`verdict` and each check `status` must be `PASS`, `FAIL`, or `INCONCLUSIVE`.
