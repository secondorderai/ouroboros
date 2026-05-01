# Handle Approvals And Permission Requests

## What This Is For

Approvals let you review higher-risk agent actions before they proceed. The app
surfaces approval requests as toasts and in the `Pending Approvals` queue.

## When To Use It

Use approvals when the agent asks for permission leases, self-modification,
worker diffs, or other actions controlled by the permission model.

## Steps

1. Watch for approval toasts while the agent is working.
2. Open the command palette with `Cmd+K` or `Ctrl+K`.
3. Choose `Approvals queue`.
4. In `Pending Approvals`, review the request description, risk badge, type,
   and timestamp.
5. For permission leases, review requested tools, paths, commands, and
   expiration.
6. For worker diffs, review the changed file count, task, review status, tests,
   and file list.
7. Click `Approve` to allow the request or `Deny` to reject it.

## Try It

In `Workspace` mode, prompts like these may lead to approval requests depending
on your permission settings and the folder you selected:

```text
Look at this folder and suggest a tidy structure before changing anything.
```

```text
If it is allowed, create a short grocery-list note in this folder. Ask before making changes.
```

```text
Review this folder and tell me what you would need permission to do next.
```

## Constraints And Gotchas

- Failed approval responses keep the approval visible and show an error.
- The title bar shows a badge count when approvals are pending.
- Higher permission tiers can be configured in Settings, but sensitive tiers may
  require confirmation before enabling.
- The app may also show interactive Ask User dialogs when the agent needs
  non-permission input.

## Related Guides

- [Configure desktop appearance, permissions, skills, RSI, and memory](desktop-settings.md)
- [Use the command palette](command-palette.md)
- [Manage the team graph and subagent activity](team-graph-and-subagents.md)
