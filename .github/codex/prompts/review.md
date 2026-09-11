Review the complete implementation diff independently. Use up to three native Codex
subagents for complementary read-only review areas and wait for every result.

Cover correctness, security, error handling and silent failures, type invariants,
performance, race conditions, regression coverage, and project conventions. For UI
changes, include accessibility, DESIGN.md, and interaction coverage. Pay particular
attention to the CLI's sandbox/permission gates and typed Electron IPC boundaries.
Inspect callers and tests to substantiate findings. Do not invoke Claude plugins or
modify files. Report actionable findings with stable IDs, severity, file, and detail.
Critical and warning findings block presentation; suggestions do not.
