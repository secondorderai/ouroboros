# Configure Desktop Appearance, Permissions, Skills, RSI, And Memory

## What This Is For

Settings control the desktop shell, provider configuration, permissions, skill
availability, self-improvement behavior, memory consolidation, and mode state.

## When To Use It

Use Settings when changing app preferences, adjusting safety boundaries,
enabling or disabling skills, tuning RSI behavior, or changing memory
consolidation timing.

## Steps

1. Open Settings from the sidebar `Settings` button, `Cmd+,`, `Ctrl+,`, or the
   command palette.
2. Choose `Appearance` to set `Theme` to `Light`, `Dark`, or `System`, and set
   `Font Size` to `Small`, `Medium`, or `Large`.
3. Choose `Permissions` to enable or disable permission tiers.
4. Choose `Skills` to review available skills, enable or disable them, add a
   skills lookup path, or remove a lookup path.
5. Choose `RSI Behavior` to toggle `Auto-reflect` or set `Novelty Threshold`.
6. Choose `Memory` to set `Consolidation Schedule` to `Session-end`, `Daily`,
   or `Manual`.
7. Choose `Modes` to review the current mode state and enter or exit `Plan`.
8. Close Settings with the close button or `Escape`.

## Try It

After changing appearance or behavior settings, try:

```text
Give me a clean, readable checklist for resetting my desk at the end of the day.
```

After changing skills or RSI settings, try:

```text
Help me turn my preferred planning style into a repeatable checklist.
```

After changing memory settings, try:

```text
Remember that I prefer short summaries first, then detailed steps only when I ask.
```

## Constraints And Gotchas

- Permission tiers describe increasing capability. Higher-risk tiers may show a
  confirmation prompt before enabling.
- Skill toggles affect prompt catalog lookup, slash invocation, and activation.
  They do not remove the underlying skill files.
- Skills lookup paths are scanned alongside built-in and user-global skill
  roots.
- A higher novelty threshold means fewer skill candidates are generated.
- `Manual` memory consolidation means memory is consolidated only when a dream
  cycle is triggered manually.
- Settings show load or save errors in a banner and keep the previous value when
  a save fails.

## Related Guides

- [Configure model providers, API keys, ChatGPT auth, and reasoning effort](model-providers-api-keys-and-reasoning.md)
- [Use slash-invoked Agent Skills](slash-invoked-agent-skills.md)
- [View RSI history and run dream cycles](rsi-history-and-dream-cycles.md)
- [Handle approvals and permission requests](approvals-and-permissions.md)
- [Use Plan mode](plan-mode.md)
