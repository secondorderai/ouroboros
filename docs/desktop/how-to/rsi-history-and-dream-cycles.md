# View RSI History And Run Dream Cycles

## What This Is For

The Self-Improvement drawer shows reflection activity, checkpoints, skill
signals, and memory consolidation events. A dream cycle consolidates memory into
durable knowledge.

## When To Use It

Use the drawer when you want to inspect what the agent learned, what it
remembered, which skills are loaded, or whether long-session memory activity is
healthy.

## Steps

1. Click the serpent icon in the title bar, or open the command palette and
   choose `View evolution log`.
2. In `Overview`, review total skills, generated skills, analyzed sessions, and
   success rate.
3. Click `Run dream cycle` to manually run memory consolidation.
4. Open `History` to browse reflection checkpoints and evolution events.
5. Use the filters: `All`, `Reflections`, `Crystallizations`, `Dream`,
   `Memory`, and `Errors`.
6. Select a history item to inspect its detail pane.
7. Open `Skills` to view loaded skills and their source badges.
8. Drag the drawer edge to resize it.

## Try It

Run a few ordinary prompts, then open the Self-Improvement drawer:

```text
Help me make a repeatable checklist for preparing for a busy Monday.
```

```text
After this answer, summarize what you learned about how I like plans organized.
```

```text
Turn this recurring problem into a reusable process: I start too many tasks and finish too few.
```

Then click `Run dream cycle` and review what appears in `History`.

## Constraints And Gotchas

- `Run dream cycle` is disabled while a dream cycle is already running.
- Checkpoint detail may show sections such as goal, current plan, completed
  work, open loops, durable memory candidates, and skill candidates.
- Empty states are normal when no RSI activity has been recorded yet.
- RSI behavior and memory consolidation schedule are configured in Settings.

## Related Guides

- [Configure desktop appearance, permissions, skills, RSI, and memory](desktop-settings.md)
- [Use the command palette](command-palette.md)
- [Use slash-invoked Agent Skills](slash-invoked-agent-skills.md)
