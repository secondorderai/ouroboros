# Approval Toast & Queue

**Phase:** 3.3 — RSI & Approvals
**Type:** Frontend
**Priority:** P0
**Depends on:** 03-ipc-bridge
**Repo:** `packages/desktop/`

## Context

When the agent proposes Tier 3/4 self-modifications (system prompt changes, config edits, permission changes), the user must approve or deny them. Approvals appear as non-blocking toast notifications — the user can keep chatting and address them when ready.

## Requirements

### Approval Toast

A floating card that appears in the top-right corner of the app when an `approval/request` notification arrives.

- **Position:** Fixed top-right, 16px from edges. Multiple toasts stack vertically with 8px gap.
- **Background:** `var(--bg-chat)`, border: `1px solid var(--border-light)`, radius: 12px, shadow: `var(--shadow-lg)`
- **Animation:** Slides in from the right (200ms ease). Slides out on dismiss.
- **Content:**
  - Title: "Approval Required" (14px weight 600)
  - Description: plain language summary of what's proposed (13px, `var(--text-secondary)`)
  - Risk badge: pill with color — red for "high", orange for "medium", gray for "low"
  - Optional diff preview: first 5 lines of the diff in a monospace block (if `diff` is provided)
- **Actions:**
  - "Approve" button (amber primary)
  - "Deny" button (danger/red)
  - Both call `approval/respond` via RPC with the approval ID and decision
- **Persistence:** Toast stays visible until the user responds. Does NOT auto-dismiss.
- **Non-blocking:** The user can keep interacting with the chat while toasts are visible.

### Approval Queue

Accessible via command palette ("Approvals queue") or a badge on the serpent icon when approvals are pending.

- Full-screen modal or drawer listing all pending approvals
- Each item shows: description, risk level, timestamp, approve/deny buttons
- Items disappear from the queue when approved or denied
- If there are no pending approvals, show "No pending approvals" empty state

### Badge Indicator

When there are pending approvals:
- Show a small red dot or count badge on the serpent status indicator
- Badge disappears when all approvals are resolved

### Notification Flow

1. CLI sends `approval/request` notification with `{ id, description, risk, diff? }`
2. Renderer adds to pending approvals list and shows a toast
3. User clicks Approve or Deny
4. Renderer calls `approval/respond` with `{ id, decision }`
5. Toast slides out. Item removed from pending list. Badge updates.

## Scope Boundaries

- The CLI-side approval queue (storing and resolving approvals) is handled by the `--json-rpc` mode (ticket 01). This ticket is purely the UI.
- Diff rendering is basic (monospace text, not a full diff viewer). Rich diff viewing is P2.
- No "defer" or "ask for more info" actions — just approve or deny.

## Acceptance Criteria

- [ ] Approval toast appears when `approval/request` notification arrives
- [ ] Toast shows description, risk badge, and approve/deny buttons
- [ ] Approve calls `approval/respond` with `decision: 'approve'`
- [ ] Deny calls `approval/respond` with `decision: 'deny'`
- [ ] Toast slides out after user responds
- [ ] Toast persists until user responds (no auto-dismiss)
- [ ] Multiple toasts stack vertically
- [ ] Badge appears on serpent icon when approvals are pending
- [ ] Approval queue is accessible via command palette
- [ ] Queue shows empty state when no approvals are pending

## Feature Tests

- **Test: Toast appears on approval request**
  - **Setup:** Mock CLI sends `approval/request` with `{ id: "a1", description: "Modify system prompt", risk: "high" }`.
  - **Expected:** Toast slides in from top-right with red "high" risk badge.

- **Test: Approve flow**
  - **Setup:** Toast is visible. Click "Approve".
  - **Expected:** `approval/respond` RPC called with `{ id: "a1", decision: "approve" }`. Toast slides out.

- **Test: Deny flow**
  - **Setup:** Toast is visible. Click "Deny".
  - **Expected:** `approval/respond` RPC called with `{ id: "a1", decision: "deny" }`. Toast slides out.

- **Test: Multiple toasts stack**
  - **Setup:** Two `approval/request` notifications arrive.
  - **Expected:** Two toasts visible, stacked vertically with 8px gap.

- **Test: Badge on serpent icon**
  - **Setup:** One pending approval.
  - **Expected:** Red dot/count badge visible on serpent icon. After approval, badge disappears.

- **Test: Non-blocking**
  - **Setup:** Toast is visible. User types and sends a message.
  - **Expected:** Message sends normally. Toast remains visible. Agent responds while toast is still showing.

## Notes

- Use `position: fixed` with `top` and `right` offsets for toast positioning. Track toast count for stacking offset.
- The toast component should be rendered in a portal (React portal) at the app root level so it overlays everything.
- For the diff preview, just use a `<pre>` with monospace font — no syntax highlighting needed for diffs at this stage.
