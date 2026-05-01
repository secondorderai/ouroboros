# Choose Simple Or Workspace Mode

## What This Is For

The desktop app can run a conversation in `Simple` mode or `Workspace` mode.
`Simple` gives the chat an isolated folder. `Workspace` lets the agent work in a
folder you choose.

## When To Use It

Use `Simple` for general questions, planning, writing, and chats that do not
need access to your files. Use `Workspace` when the agent should inspect or
work with files in a folder you choose.

## Steps

1. Use the mode selector in the center of the title bar.
2. Choose `Simple` to create isolated chats.
3. Choose `Workspace` to select a folder.
4. If prompted, pick the folder that should become the workspace.
5. Start the conversation.

## Try It

For `Simple` mode, try:

```text
Help me compare three vacation ideas by cost, effort, and how relaxing they sound.
```

```text
Make a packing checklist for a two-night trip with unpredictable weather.
```

For `Workspace` mode, choose a folder with personal notes, planning files, or
other documents and try:

```text
Look through this folder and summarize what it seems to be for in plain language.
```

## Constraints And Gotchas

- The title-bar mode is fixed after a conversation starts. Start a new
  conversation to change modes.
- `Workspace` mode shows the selected folder path in the title bar.
- `Simple` sessions still have an isolated working location, but they are not
  tied to a folder you selected.
- Opening a workspace from the command palette switches the next empty chat into
  `Workspace` mode after you pick a folder.

## Related Guides

- [Get started and complete onboarding](getting-started-and-onboarding.md)
- [Manage sessions](sessions.md)
- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
