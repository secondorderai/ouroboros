# Epic: Ouroboros Electron Desktop App (Phase 3)

**Phase:** 3 — Desktop App
**Type:** Epic
**Priority:** P0

## Context

Phase 2 delivered the RSI engine — reflection, skill crystallization, self-testing, dream cycle, evolution logging, and the autonomous improvement orchestrator. The CLI agent is fully functional and self-improving.

Phase 3 wraps the CLI in an Electron desktop application for users who prefer a GUI over the terminal. The desktop app is a pure presentation layer — all intelligence remains in the CLI process, communicated via JSON-RPC over stdin/stdout. This follows the same architecture as the Claude Code desktop app and Codex app.

**PRD Reference:** `docs/electron-desktop-prd.md`
**Design Spec:** `docs/superpowers/specs/2026-04-06-electron-desktop-app-design.md`
**Design System:** `DESIGN.md`

## Target Packages

- **Ticket 01** (CLI JSON-RPC mode) is implemented in `packages/cli/`
- **Tickets 02-13** (Electron app) are implemented in `packages/desktop/`

## Child Tickets (dependency order)

### Phase 3.1 — Scaffolding (independent start)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 01 | [CLI JSON-RPC Mode](./01-cli-json-rpc.md) | packages/cli/ | Add `--json-rpc` flag to CLI for desktop app communication |
| 02 | [Electron Project Scaffolding](./02-electron-scaffolding.md) | packages/desktop/ | Initialize Electron + React + Vite project with app shell |
| 03 | [IPC Bridge & CLI Process Manager](./03-ipc-bridge.md) | packages/desktop/ | Connect Electron main process to CLI child process |

### Phase 3.2 — Chat Core (depends on 03)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 04 | [Chat Message List & Streaming](./04-chat-messages.md) | packages/desktop/ | Message rendering with streamed text and virtual scrolling |
| 05 | [Markdown Renderer & Code Highlighting](./05-markdown-renderer.md) | packages/desktop/ | GFM rendering with syntax-highlighted code blocks |
| 06 | [Tool Call Chip Component](./06-tool-call-chips.md) | packages/desktop/ | Compact expandable pills for tool call visualization |
| 07 | [Input Bar & Session Sidebar](./07-input-bar-sessions.md) | packages/desktop/ | Message input, file attachments, workspace picker, session management |

### Phase 3.3 — RSI & Approvals (depends on 03)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 08 | [RSI Status Indicator & Drawer](./08-rsi-drawer.md) | packages/desktop/ | Serpent icon, activity feed, skills list, dream trigger |
| 09 | [Approval Toast & Queue](./09-approval-system.md) | packages/desktop/ | Non-blocking approval cards for Tier 3/4 modifications |

### Phase 3.4 — Navigation & Settings (depends on 04)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 10 | [Command Palette](./10-command-palette.md) | packages/desktop/ | Fuzzy search modal for all app actions |
| 11 | [Settings Overlay](./11-settings-overlay.md) | packages/desktop/ | Full-screen settings with model, permissions, RSI, appearance |

### Phase 3.5 — Onboarding (depends on 11)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 12 | [Onboarding Wizard](./12-onboarding-wizard.md) | packages/desktop/ | 3-step first-launch wizard with template selection |

### Phase 3.6 — Packaging (depends on all)

| # | Ticket | Repo | Description |
|---|--------|------|-------------|
| 13 | [Packaging, Signing & Auto-Update](./13-packaging.md) | packages/desktop/ | electron-builder, code signing, auto-update, CLI bundling |

## Dependency Graph

```
01-cli-json-rpc ──────┐
                      ├──> 03-ipc-bridge ──┬──> 04-chat-messages ──┬──> 05-markdown-renderer
02-electron-scaffolding┘                   │                       ├──> 06-tool-call-chips
                                           │                       ├──> 07-input-bar-sessions
                                           │                       └──> 10-command-palette
                                           │
                                           ├──> 08-rsi-drawer
                                           ├──> 09-approval-system
                                           └──> 11-settings-overlay ──> 12-onboarding-wizard
                                                                               │
                                           All ────────────────────────> 13-packaging
```

## Deliverable

A signed, distributable Electron desktop app for macOS and Windows that provides a chat-first GUI to the Ouroboros agent with RSI visibility, command palette navigation, and guided onboarding.

## Success Criteria

- [ ] App installs and launches on macOS (Ventura+) and Windows (10+)
- [ ] User completes onboarding wizard and sends first message in < 3 minutes
- [ ] Agent responses stream in real-time with tool call visualization
- [ ] RSI activity is visible via serpent indicator and drawer
- [ ] Command palette provides access to all features
- [ ] Approval toasts appear for Tier 3/4 proposals
- [ ] Auto-update checks and applies new versions
- [ ] Cold start < 2 seconds, first token visible < 500ms (excluding network)
