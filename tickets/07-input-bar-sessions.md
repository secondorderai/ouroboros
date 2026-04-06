# Input Bar & Session Sidebar

**Phase:** 3.2 — Chat Core
**Type:** Frontend
**Priority:** P0
**Depends on:** 04-chat-messages
**Repo:** `ouroboros-desktop`

## Context

The input bar is how users talk to the agent. The session sidebar is how they manage conversations. Together they complete the core chat experience.

## Requirements

### Input Bar

Fixed at the bottom of the chat area. Contains:

- **Textarea:** Auto-resizes from 1 to 5 lines, then scrolls. 15px font, `var(--font-sans)`. Placeholder: "Message Ouroboros..."
- **Send button:** Amber primary button, right of textarea. Enter to send, Shift+Enter for newline. Disabled when textarea is empty. Replaced by a cancel/stop button while the agent is running.
- **Attachment button:** Icon button left of textarea. Opens native file picker via `showOpenDialog`. Selected files appear as removable chips below the textarea. File paths are included in the `agent/run` params as `attachments`.
- **Workspace indicator:** Bottom-left meta line. Folder icon + truncated path (e.g., `~/projects/myapp`). Click opens native folder picker. Sends `workspace/set` via RPC on change.
- **Model badge:** Bottom-right meta line. Small pill showing model name (e.g., "claude-opus-4-6"). Click opens command palette filtered to model change (if command palette exists, otherwise no-op until ticket 10).

### File Attachment Handling

- Drag-and-drop files onto the input bar or chat area to attach
- Drop zone visual feedback: dashed amber border when dragging over
- Attached files shown as chips: filename + remove X button
- On send, file paths are passed via `agent/run` `attachments` param
- Supported: any file the OS file picker can select. No size filtering in the app — the CLI decides what to do with the files.

### Session Sidebar

- Width: 250px, collapsible to 0 with animation (200ms slide)
- Toggle: hamburger icon in the title bar or Cmd+B / Ctrl+B
- Background: `var(--bg-sidebar)`

**Content:**

- **New conversation button** at top: "+" icon button. Calls `session/new` via RPC, clears chat.
- **Session list:** Grouped by date (Today, Yesterday, This Week, Older). Each item shows:
  - Session title (auto-generated from first user message, truncated to 50 chars)
  - Relative time (e.g., "2h ago")
  - Message count badge
- **Active session:** Highlighted with `var(--bg-sidebar-active)`, 6px radius
- **Click session:** Calls `session/load` via RPC, populates the chat with loaded messages
- **Delete session:** Right-click context menu with "Delete" option. Confirmation dialog. Calls `session/delete` via RPC.

### Session State

- On app launch, call `session/list` to populate the sidebar
- On new conversation, add the session to the top of the list
- On `agent/turnComplete`, update the session's title (if first message) and message count
- Current session ID tracked in the conversation store

## Scope Boundaries

- Drag-and-drop for folders (workspace) is included. Drag-and-drop for files is included. Both use the same drop zone.
- Session search/filter is out of scope (P2)
- Session rename is out of scope (P2)
- Multi-select/bulk delete is out of scope

## Acceptance Criteria

- [ ] Textarea auto-resizes from 1-5 lines, then scrolls
- [ ] Enter sends, Shift+Enter adds newline
- [ ] Send button is disabled when empty, replaced by stop button when agent is running
- [ ] Attachment button opens file picker; selected files appear as chips
- [ ] Drag-and-drop files onto the chat area attaches them
- [ ] Workspace indicator shows current path; click changes workspace
- [ ] Model badge shows current model name
- [ ] Session sidebar lists conversations grouped by date
- [ ] Clicking a session loads its history into the chat
- [ ] New conversation button creates a fresh session
- [ ] Delete session removes it from the list after confirmation
- [ ] Sidebar collapses/expands with Cmd+B or hamburger toggle
- [ ] Sidebar state (open/closed) persists across restarts

## Feature Tests

- **Test: Send message flow**
  - **Setup:** Type "Hello" in the textarea.
  - **Action:** Press Enter.
  - **Expected:** User message appears in chat. `agent/run` RPC is called. Textarea clears. Send button becomes stop button.

- **Test: Textarea auto-resize**
  - **Setup:** Type a single line. Then paste 6 lines of text.
  - **Expected:** Textarea grows to 5 lines, then shows a scrollbar for the 6th.

- **Test: File attachment via drag-and-drop**
  - **Setup:** Drag a file over the chat area.
  - **Expected:** Drop zone border appears. Drop the file. Chip appears below textarea with filename and X button.

- **Test: Workspace change**
  - **Setup:** Click the workspace indicator.
  - **Action:** Select a new folder in the OS picker.
  - **Expected:** Workspace indicator updates. `workspace/set` RPC is called.

- **Test: Session sidebar loads history**
  - **Setup:** Two sessions exist. Click the second session.
  - **Expected:** Chat clears and shows the loaded session's messages.

- **Test: New conversation**
  - **Setup:** In an active conversation. Click "+" in sidebar.
  - **Expected:** Chat clears. New empty session. New entry appears at top of sidebar.

- **Test: Delete session**
  - **Setup:** Right-click a session in the sidebar.
  - **Action:** Click "Delete", confirm.
  - **Expected:** Session removed from sidebar. If it was active, chat clears.

## Notes

- The textarea should use a `ref` to measure content height and set `style.height` dynamically. Cap at 5 * line-height.
- For drag-and-drop, use the HTML5 Drag and Drop API with `dragenter`/`dragleave`/`drop` events. Detect folders vs files from the dropped items.
- Session grouping by date uses relative date calculation: today, yesterday, within 7 days, older. Update on sidebar render, not on a timer.
- The sidebar collapsed state should be stored in the conversation store (Zustand) and persisted via electron-store.
