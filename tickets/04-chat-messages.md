# Chat Message List & Streaming Renderer

**Phase:** 3.2 — Chat Core
**Type:** Frontend
**Priority:** P0
**Depends on:** 03-ipc-bridge
**Repo:** `packages/desktop/`

## Context

The chat message list is the primary surface of the app. It displays the conversation between user and agent, renders streamed agent responses in real-time, and hosts tool call chips and RSI notifications inline. This is the most important component in the entire app — it must feel fast, smooth, and reliable.

## Requirements

### Message List Component

- Renders an ordered list of messages: user messages, agent messages, and system messages
- **Virtual scrolling** for conversations with 100+ messages — only DOM-render messages in/near the viewport. Use a virtual list library (e.g., `@tanstack/react-virtual` or `react-virtuoso`).
- Auto-scroll to bottom when new messages arrive (unless user has scrolled up)
- "Jump to bottom" button appears when scrolled up and new messages arrive
- 16px vertical gap between messages per DESIGN.md

### User Message Bubble

- Right-aligned with warm background (`var(--bg-user-msg)`)
- Radius: `16px 16px 4px 16px` (flat bottom-right)
- Max width: 80% of chat area
- Plain text rendering (no markdown — user messages are just text)
- File attachment chips below the message text (if files were attached)

### Agent Message

- Left-aligned with Ouroboros avatar (28px circle)
- "Ouroboros" name label above the message body (14px weight 600)
- Max width: 80% of chat area, capped at 720px
- **Streaming text rendering:** As `agent/text` notifications arrive, append text chunks to the current message. Show a blinking cursor at the end while streaming.
- **Batch rendering:** Buffer incoming chunks and flush to DOM at most once per animation frame (requestAnimationFrame). Never re-render on every individual chunk.
- Markdown rendering is handled by a child component (ticket 05). During streaming, render raw text with line breaks. Once `agent/turnComplete` arrives, switch to full markdown rendering.
- Tool call chips appear inline between text paragraphs (ticket 06 builds the component, this ticket provides the insertion points)

### Message State Management

- **Conversation store:** Zustand or similar lightweight store holding:
  - `messages: Message[]` — the current conversation's messages
  - `streamingText: string | null` — text being streamed for the current agent turn
  - `activeToolCalls: Map<string, ToolCallState>` — tool calls in progress
  - `isAgentRunning: boolean` — whether the agent is currently executing
- **Wire to IPC notifications:**
  - `agent/text` → append to `streamingText`
  - `agent/toolCallStart` → add to `activeToolCalls`
  - `agent/toolCallEnd` → update tool call status in `activeToolCalls`, move to completed
  - `agent/turnComplete` → finalize `streamingText` into a completed message, clear streaming state
  - `agent/error` → show error message in chat

### Send / Cancel

- When user sends a message: add user message to `messages`, call `rpc('agent/run', { message })`, set `isAgentRunning = true`
- When user cancels: call `rpc('agent/cancel', { id })`, set `isAgentRunning = false`
- Cancel button replaces the send button while the agent is running

## Scope Boundaries

- Markdown rendering is stubbed (just render raw text with line breaks) — ticket 05 adds the full renderer
- Tool call chip component is stubbed (just show tool name) — ticket 06 builds it
- Input bar and session sidebar are separate — ticket 07
- File attachments display is basic (filename chip) — ticket 07 adds drag-and-drop

## Acceptance Criteria

- [ ] Messages render with correct alignment (user right, agent left)
- [ ] User messages use the warm bubble style from DESIGN.md
- [ ] Agent messages show avatar and name label
- [ ] Streaming text appends smoothly at 60fps with no flicker
- [ ] Blinking cursor appears at the end of streaming text
- [ ] `agent/turnComplete` finalizes the message (cursor disappears)
- [ ] Virtual scrolling handles 200+ messages without performance degradation
- [ ] Auto-scroll to bottom on new messages (when already at bottom)
- [ ] "Jump to bottom" button appears when scrolled up during active streaming
- [ ] Cancel button is visible during agent execution and stops the run
- [ ] Agent errors display as error messages in the chat
- [ ] Conversation state is managed in a store, not component-local state

## Feature Tests

- **Test: User message renders correctly**
  - **Setup:** Send a message "Hello".
  - **Expected:** Right-aligned bubble with warm background, message text visible.

- **Test: Agent streaming renders smoothly**
  - **Setup:** Mock CLI sends 50 `agent/text` notifications with small chunks.
  - **Expected:** Text appears incrementally with blinking cursor. No frame drops.

- **Test: Turn complete finalizes message**
  - **Setup:** Streaming is in progress. Mock CLI sends `agent/turnComplete`.
  - **Expected:** Cursor disappears. Message content matches the full text.

- **Test: Virtual scrolling performance**
  - **Setup:** Load a conversation with 300 messages.
  - **Action:** Scroll through the list.
  - **Expected:** Smooth scrolling. DOM only contains ~20-30 message elements at a time.

- **Test: Auto-scroll behavior**
  - **Setup:** User is at the bottom. Agent starts streaming.
  - **Expected:** Chat auto-scrolls as new text arrives.
  - **Setup 2:** User scrolls up 200px. Agent starts streaming.
  - **Expected:** Chat does NOT auto-scroll. "Jump to bottom" button appears.

- **Test: Cancel stops agent**
  - **Setup:** Agent is streaming. Click cancel.
  - **Expected:** `agent/cancel` RPC is sent. Streaming stops. Message finalizes with whatever text was received.

## Notes

- The streaming render batching is critical for performance. LLMs can output 50+ tokens/second, each as a separate `agent/text` notification. Without batching, this would be 50+ React re-renders per second. Use `requestAnimationFrame` to batch into ~60 renders/second.
- For the virtual list, `react-virtuoso` handles auto-scroll and "stick to bottom" behavior out of the box, which saves significant implementation effort.
- The streaming text should be rendered as a `<pre>` or with `white-space: pre-wrap` during streaming, then replaced with the markdown-rendered version on completion. This avoids expensive markdown parsing on every chunk.
