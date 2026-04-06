# Tool Call Chip Component

**Phase:** 3.2 — Chat Core
**Type:** Frontend
**Priority:** P0
**Depends on:** 04-chat-messages
**Repo:** `packages/desktop/`

## Context

Tool calls are the agent's hands — file reads, bash commands, web fetches. Non-technical users don't need to see raw tool output, but they should know the agent is doing something. Tool call chips are compact pills that show activity and expand on click to reveal details.

## Requirements

### Chip Component (collapsed state)

- Background: `var(--bg-tool-chip)`, border: `1px solid var(--border-light)`, radius: 6px
- Layout: icon (14px) + human-readable label + status indicator
- Padding: 6px 12px
- Font: 13px weight 500, `var(--text-secondary)`
- Cursor: pointer

### Human-Readable Label Mapping

| Tool Name | Label | Icon |
|-----------|-------|------|
| `bash` | "Ran command" | Terminal icon |
| `file-read` | "Read file" | File icon |
| `file-write` | "Created file" | File-plus icon |
| `file-edit` | "Edited file" | Pencil icon |
| `web-fetch` | "Fetched URL" | Globe icon |
| `web-search` | "Searched web" | Search icon |
| `memory` | "Updated memory" | Brain icon |
| `reflect` | "Reflecting..." | Mirror/sparkle icon |
| `crystallize` | "Crystallizing skill..." | Diamond icon |
| `self-test` | "Running tests..." | Check-circle icon |
| `skill-gen` | "Generating skill..." | Wand icon |
| `dream` | "Dreaming..." | Moon icon |
| `evolution` | "Logging evolution" | Timeline icon |
| (unknown) | Tool name as-is | Wrench icon |

### Status Indicators

| State | Indicator |
|-------|-----------|
| Running | Animated spinner (small, 12px) |
| Completed | Green checkmark |
| Failed | Red X icon |

### Expanded State (on click)

- Background: `var(--bg-tool-expanded)`, border: `1px solid var(--border-light)`, radius: 10px
- **Header:** Same as collapsed chip, plus duration text (e.g., "1.2s") right-aligned
- **Input section:** "Input" subheading, then the tool input displayed:
  - For `bash`: show the command in a monospace code block
  - For `file-read`/`file-edit`/`file-write`: show the file path
  - For `web-fetch`/`web-search`: show the URL or query
  - For others: show JSON params in a code block
- **Output section:** "Output" subheading, then the tool result:
  - Syntax-highlighted code block for code/text output
  - Error message in red if `isError: true`
  - Truncate output at 50 lines with a "Show all (N lines)" expander
- Max height: 300px with scroll
- Click header again to collapse

### Integration with Chat Messages

Tool call chips appear inline in agent messages, positioned between text paragraphs. The message list (ticket 04) provides insertion points via `agent/toolCallStart` and `agent/toolCallEnd` notifications.

When a tool call is in progress (started but not ended), the chip shows the running spinner. When `agent/toolCallEnd` arrives, it transitions to completed or failed.

## Scope Boundaries

- Icons can be simple SVG or emoji placeholders initially — polished icons can be refined later
- Duration is calculated from `toolCallStart` to `toolCallEnd` timestamps — if the IPC doesn't provide timestamps, estimate from notification arrival times
- No "re-run" or "copy" actions on tool calls (those are P2+)

## Acceptance Criteria

- [ ] Tool call chips render inline in agent messages with correct styling
- [ ] Each tool name maps to a human-readable label and icon
- [ ] Running tool calls show a spinner; completed show a checkmark; failed show a red X
- [ ] Clicking a chip expands it to show input and output
- [ ] Clicking the header of an expanded chip collapses it
- [ ] Output is syntax-highlighted for code content
- [ ] Long output is truncated at 50 lines with a "Show all" expander
- [ ] Failed tool calls show the error message in red
- [ ] Expand/collapse transitions are animated (200ms ease)

## Feature Tests

- **Test: Chip renders for bash tool call**
  - **Setup:** `agent/toolCallStart` with `toolName: 'bash'`.
  - **Expected:** Chip shows terminal icon + "Ran command" + spinner.

- **Test: Chip completes with checkmark**
  - **Setup:** `agent/toolCallEnd` with `isError: false`.
  - **Expected:** Spinner transitions to green checkmark.

- **Test: Expand shows input and output**
  - **Setup:** Completed bash tool call. Click the chip.
  - **Expected:** Expanded view shows the command in a code block and the output below.

- **Test: Failed tool call shows error**
  - **Setup:** `agent/toolCallEnd` with `isError: true`.
  - **Expected:** Chip shows red X. Expanded view shows error message in red.

- **Test: Long output truncation**
  - **Setup:** Tool output is 200 lines.
  - **Expected:** Only first 50 lines shown. "Show all (200 lines)" link visible. Clicking it reveals all lines.

- **Test: Unknown tool falls back gracefully**
  - **Setup:** `agent/toolCallStart` with `toolName: 'custom-tool'`.
  - **Expected:** Chip shows wrench icon + "custom-tool" as label.

## Notes

- Use Lucide React or Heroicons for the icon set — they're lightweight and have all the icons needed.
- The chip should be a single React component with `collapsed`/`expanded` state. Animate height transition with CSS `max-height` or `framer-motion`.
- For syntax highlighting in the output, reuse the same highlighter from ticket 05 (markdown renderer).
