# Send Messages, Stop Runs, Steer Runs, And Read Status Badges

## What This Is For

The composer is the main way to talk to Ouroboros. It also shows active mode,
selected skills, context usage, reasoning effort, and the current model.

## When To Use It

Use this workflow for normal chat, long-running agent work, changing direction
mid-run, and checking whether the current conversation is approaching its
context limit.

## Steps

1. Type in `Message Ouroboros...`.
2. Press `Enter` or click `Send message`.
3. Use `Shift+Enter` to add a new line without sending.
4. While the agent is running, click `Stop agent` to cancel the run.
5. While the agent is running, type a new instruction in `Steer the agent...`
   and click `Steer current turn`.
6. Watch tool-call chips in the assistant message to see what the agent is
   doing.
7. Read the bottom row for the active mode, selected skill, context usage,
   reasoning effort, and model name.
8. If a context badge appears, hover it to see the token breakdown.
9. If a reasoning chip appears, click it to choose the reasoning effort.

## Try It

Start with:

```text
Help me make a simple plan for a small dinner party for six people.
```

While the agent is running, steer it with:

```text
Make it vegetarian and keep the prep time under one hour.
```

Or try a longer answer where the context and model badges are useful:

```text
Interview me about my weekly schedule, then turn my answers into a practical weekly plan.
```

## Constraints And Gotchas

- Steering injects text at the next agent step; it may not interrupt the exact
  operation already in progress.
- Files-only steering is not meaningful. Add text when steering an active run.
- Context badges become more important when they show warning or critical
  styling.
- Reasoning options depend on the selected model.

## Related Guides

- [Attach files and images](attachments.md)
- [Use slash-invoked Agent Skills](slash-invoked-agent-skills.md)
- [Use Plan mode](plan-mode.md)
