# Manage Artifacts And HTML Apps

## What This Is For

Artifacts are self-contained HTML apps or previews created by the agent. The
desktop app shows them in a right-side panel so you can inspect, switch versions,
open externally, download, hide, or view them fullscreen.

## When To Use It

Use the artifact panel when the agent creates an HTML preview, prototype,
report, visualization, or other browser-rendered output.

## Steps

1. Ask the agent to create an artifact or HTML app.
2. When the artifact appears, use the right-side artifact panel.
3. Use the artifact picker to switch between artifacts.
4. If multiple versions exist, use the version picker to choose a version.
5. Leave `Follow latest` checked to automatically show the newest artifact.
6. Click `Download artifact` to save the current HTML.
7. Click `Open externally` to open the artifact outside the app.
8. Click `Enter fullscreen` to focus on the artifact; press `Escape` or click
   `Exit fullscreen` to return.
9. Click `Hide HTML5 app` to close the panel. Use the title-bar HTML app button
   to show it again.
10. Drag the panel edge to resize it.

## Try It

Ask the agent for a visual artifact:

```text
Create a simple interactive weekly habit tracker I can use in the app.
```

```text
Create a one-page visual dashboard for planning a weekend trip.
```

```text
Create a tiny HTML flashcard app for practicing five new Spanish phrases.
```

## Constraints And Gotchas

- The artifact panel appears only when the current session has artifacts.
- Hiding the panel does not delete artifacts.
- Fullscreen hides the sidebar and chat until you exit fullscreen.
- Download saves the current rendered HTML version, not every artifact version.

## Related Guides

- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
- [Manage sessions](sessions.md)
