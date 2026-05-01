# Manage The Team Graph And Subagent Activity

## What This Is For

Subagent activity shows delegated work inside assistant messages. The team graph
drawer shows assignments, dependencies, quality gates, required artifacts, and
recent workflow events for team-style work.

## When To Use It

Use this feature when the agent delegates work, runs a team workflow, or exposes
a graph of task dependencies and agent assignments.

## Steps

1. Watch assistant messages for subagent activity rows.
2. Expand a subagent row to inspect status, messages, evidence, permission
   leases, or worker diff summaries.
3. Click the team graph affordance in a subagent row, or click `Open team graph`
   in the title bar when it appears.
4. In the team graph drawer, review the task summary counts.
5. Review `Agent assignments` lanes and select a task card.
6. Use the task inspector to review required artifacts, quality gates, and
   recent events.
7. Click `Refresh` to reload the graph.
8. Press `Escape` or click the close button to close the drawer.

## Try It

Try prompts that are naturally split into smaller pieces:

```text
Plan a move to a new apartment by breaking the work into clear parallel tasks.
```

```text
Compare three possible family vacation destinations and organize the research into assignments.
```

```text
Help me prepare for hosting guests by splitting food, cleaning, schedule, and shopping into separate workstreams.
```

## Constraints And Gotchas

- The title-bar team graph button appears only when graph or subagent activity
  is available.
- A cancelled team graph shows cancellation and cleanup state.
- Task lanes may include `Unassigned` when tasks do not have an agent.
- The graph can open automatically when the agent emits a team graph event.

## Related Guides

- [Handle approvals and permission requests](approvals-and-permissions.md)
- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
- [Use the command palette](command-palette.md)
