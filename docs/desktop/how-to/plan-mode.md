# Use Plan Mode

## What This Is For

`Plan` mode keeps the assistant in a planning workflow before implementation
work begins. It is useful when you want a clear plan before making changes.

## When To Use It

Use `Plan` mode for ambiguous tasks, code changes that need agreement first, or
work where success criteria and tradeoffs should be settled before execution.

## Steps

1. Click the `Mode` chip in the composer.
2. Choose `Plan`.
3. Send the planning request.
4. Review the assistant's proposed plan.
5. Use the plan decision dialog if the app presents one for the current mode
   workflow.
6. Click the active mode chip's remove button to exit `Plan` mode.
7. You can also open `Settings`, choose `Modes`, and enter or exit `Plan` from
   there.

## Try It

Enter `Plan` mode, then paste:

```text
Create a plan for organizing a messy closet without buying anything new.
```

```text
Plan a simple birthday gathering for ten people with a small budget.
```

```text
Help me decide whether to take on a new volunteer commitment by making a clear decision plan.
```

## Constraints And Gotchas

- The composer and Settings `Modes` section stay in sync.
- While mode state is updating, mode controls may be temporarily disabled.
- A visible mode error means the app could not enter or exit the mode; try
  again after the current operation settles.

## Related Guides

- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
- [Use the command palette](command-palette.md)
- [Configure desktop appearance, permissions, skills, RSI, and memory](desktop-settings.md)
