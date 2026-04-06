# Ouroboros Electron Desktop App — Design Spec

**Date:** 2026-04-06
**Status:** Approved
**Phase:** 3 (PRD Section 7.3)
**Design direction:** Chat-first conversational UI with progressive disclosure

---

## 1. Overview

A cross-platform Electron desktop app that wraps the Ouroboros CLI, providing a GUI for users who prefer not to work in terminals or IDEs. The primary audience is technical-but-GUI-preferring users and non-technical users curious about autonomous AI agents.

The design philosophy is **chat-first with progressive disclosure**: the conversation is always front and center, and everything else (skills, RSI details, settings) is one click or one Cmd+K away but never in the way.

Inspired by Claude.ai (clean, warm, generous whitespace), Linear (minimal, fast), and Arc (command palette navigation).

---

## 2. Target Users

- **Technical but non-CLI users** — Engineers, data scientists, designers who understand code but prefer a GUI over terminal workflows
- **Non-technical users** — People curious about autonomous AI agents who want to experience self-improvement firsthand
- **NOT the primary audience:** Developers who already use Claude Code / Codex CLI daily (they can use the CLI directly)

---

## 3. Architecture

The desktop app lives at `packages/desktop/` within the Ouroboros monorepo. It is a sibling package to the CLI (`packages/cli/`) and shared types (`packages/shared/`). All three packages are managed via Bun workspaces.

### 3.1 Electron Process Model

- **Main process:** Spawns the Ouroboros CLI (`packages/cli/`) as a child process, communicates via JSON-RPC over stdin/stdout (PRD Task 3.1). Handles file dialogs, system integration, auto-update, and window management.
- **Renderer process:** React app bundled with Vite. All UI rendering happens here. Located in `packages/desktop/src/`.
- **IPC bridge:** Main <-> renderer communication for CLI events, native file pickers, and system theme detection.
- **Shared types:** TypeScript interfaces shared between CLI and desktop are imported from `@ouroboros/shared` (`packages/shared/src/`).

### 3.2 CLI Bundling

The CLI binary (built from `packages/cli/`) is bundled inside the app package. Users do not need Bun, Node, or any system dependencies installed. The app spawns the bundled CLI as a child process with no PATH dependency.

### 3.3 Single Instance

One app window at a time (single instance lock). Multiple conversations are managed via the session sidebar within that window.

---

## 4. App Shell Layout

```
+-------------------------------------------------------+
| [traffic lights]   Ouroboros          [sun/moon] [O]   |  <- Title bar
+-------+-----------------------------------------------+
|       |                                               |
| Sess- |          Main content area                    |
| ion   |          (chat by default)                    |
| side- |                                               |
| bar   |                                               |
| 250px |                                               |
|       |                                               |
|       |                                               |
+-------+-----------------------------------------------+
|  [+] [workspace: ~/projects/myapp]  [opus-4-6] [Send] |  <- Input bar
+-------------------------------------------------------+
```

- **Title bar:** Custom drag region. macOS traffic lights or Windows controls (platform-native). App name "Ouroboros" center-left. Theme toggle (sun/moon icon) and Ouroboros status indicator (serpent icon) top-right.
- **Session sidebar:** Collapsible left panel (~250px). Hamburger toggle. Session history grouped by date (Today / Yesterday / This Week). Each entry shows title, time, message count.
- **Main content area:** Chat view by default. Full width when sidebar is collapsed.
- **Input bar:** Fixed bottom. See Section 5.2 for details.
- **No persistent navigation bars or activity bars.** Everything beyond chat is accessed via command palette (Cmd+K / Ctrl+K) or contextual UI.

---

## 5. Chat Experience

### 5.1 Message Types

**User messages:**
- Right-aligned bubbles with warm background
- Support plain text and attached files (shown as file chips below the message)

**Agent responses:**
- Left-aligned with Ouroboros avatar
- Clean sans-serif typography (not monospace)
- Full markdown rendering: code blocks (syntax-highlighted), lists, headers, tables
- Streaming text with a subtle blinking cursor

**Tool call chips:**
- Inline between agent text paragraphs
- Compact pill: icon + human-readable label ("Read file", "Ran command", "Edited code")
- Spinner while active, checkmark when complete
- Click to expand: input summary, raw output (syntax-highlighted for code), duration
- Multiple tool calls stack vertically
- Non-technical users see activity without needing to understand the details

**RSI ambient notifications:**
- Subtle inline card when something happens
- Plain language: "Learned a new skill from this task" or skill counter update
- Amber accent color, dismissable
- No celebration animations or fanfare

**Approval cards:**
- Float in as a toast (top-right corner) when the agent proposes a Tier 3/4 modification
- Shows: plain language description of what's proposed, risk level badge, Approve/Deny buttons
- Non-blocking: user can keep chatting and address it later
- Persists until addressed (doesn't auto-dismiss)

### 5.2 Input Bar

- Auto-resizing textarea (1-5 lines, then scrolls)
- Attachment button (opens native file picker) + drag-and-drop zone for files
- Workspace indicator: folder icon + truncated path (e.g., "~/projects/myapp"). Click to change workspace via native folder picker.
- Model badge: small pill showing current model (e.g., "claude-opus-4-6"). Click opens command palette filtered to model selection.
- Send button with amber accent. Enter to send, Shift+Enter for newline.

---

## 6. Ouroboros Status Indicator & RSI Drawer

### 6.1 Status Indicator

Located top-right of the title bar. A small serpent/infinity SVG icon (~24px).

| State | Appearance |
|-------|------------|
| Idle | Static, subtle gray |
| RSI active | Pulses with amber glow (CSS animation). Tooltip: "Reflecting on task..." |
| Skill crystallized | Brief amber flash, then returns to idle |

Click opens the RSI drawer.

### 6.2 RSI Drawer

Slides in from the right (~350px). Contains:

1. **Header:** "Self-Improvement" + close button
2. **Stats row:** 4 compact stats — Total skills, Self-generated count, Sessions analyzed, Success rate
3. **Recent activity feed:** Plain language RSI events:
   - "Reflected on file parsing task — no new skill needed"
   - "Crystallized: `bun-stream-parser` — passed 2/2 tests"
   - "Memory consolidated — merged 3 topics"
4. **Skills list:** Scrollable list with status badges (core = blue, generated = amber, staging = gray). Tap a skill to see description and metadata.
5. **Dream trigger:** Button at bottom: "Run dream cycle" for manual memory consolidation.

This drawer is the single place for all RSI visibility. Always one click away, never in the way.

---

## 7. Command Palette & Navigation

### 7.1 Command Palette (Cmd+K / Ctrl+K)

Modal overlay with fuzzy search input. This is the primary way to reach anything beyond the chat.

**Grouped sections:**

| Group | Actions |
|-------|---------|
| Actions | New conversation, Trigger dream cycle, Open workspace folder |
| Navigation | Browse skills, View evolution log, Approvals queue |
| Settings | Change model, Configure permissions, Manage API keys |

Each item shows: icon, title, short description, keyboard shortcut hint.
Arrow keys to navigate, Enter to select, Escape to close.

### 7.2 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+K` | Command palette |
| `Cmd+N` / `Ctrl+N` | New conversation |
| `Cmd+B` / `Ctrl+B` | Toggle session sidebar |
| `Cmd+,` / `Ctrl+,` | Open settings |
| `Escape` | Close any drawer / palette / modal |

### 7.3 Settings

Opens as a full-screen overlay (not a separate window).

**Sections:**
- Model & API keys (provider, model, key management)
- Permissions (tier configuration)
- RSI behavior (auto-reflect toggle, novelty threshold slider)
- Memory (consolidation schedule: session-end / daily / manual)
- Appearance (theme, font size)
- Workspace defaults

Clean form layout. Changes apply immediately.

---

## 8. First-Launch Onboarding

A 3-step wizard presented as a centered card UI.

### Step 1 — "Connect your AI"

- Model provider selector: Anthropic, OpenAI, or OpenAI-compatible endpoint
- API key input with "Test connection" button
- Model dropdown populates after successful connection
- Help link: "Don't have an API key?" with setup instructions

### Step 2 — "Choose your workspace"

- Folder picker button + drag-and-drop area
- Explanation: "This is the directory Ouroboros will work in — reading files, running commands, and creating skills"
- Skip option ("I'll set this up later") defaults to home directory

### Step 3 — "What would you like to do?"

Four template cards:

| Template | Behavior |
|----------|----------|
| **Help me with a project** | Opens chat with workspace context. Agent introduces itself, asks what you need. |
| **Explore this codebase** | Agent proactively reads workspace, gives an overview. |
| **General assistant** | No workspace focus. General-purpose conversation. |
| **Let the agent evolve** | Aggressive RSI settings. Agent explains self-improvement and invites tasks to learn from. |

Selecting a card starts the first conversation with the appropriate system context. Wizard never appears again. All settings remain accessible via Cmd+,.

---

## 9. Packaging & Platform

### 9.1 macOS

- `.dmg` installer with drag-to-Applications
- Code signed + notarized for Gatekeeper
- Native traffic light buttons positioned in custom title bar
- System dark/light mode detection for initial theme

### 9.2 Windows

- NSIS installer (standard .exe setup wizard)
- Optional portable .zip distribution
- Windows-style minimize/maximize/close buttons
- Follows system theme preference

### 9.3 Both Platforms

- Auto-update via electron-updater (checks on launch, prompts to restart)
- CLI binary bundled inside app package — no system dependencies required
- Single instance lock

### 9.4 Build Tooling

Use electron-builder or electron-forge for packaging. Produce:
- macOS: `.dmg`
- Windows: `.exe` (NSIS) + `.zip` (portable)

---

## 10. Out of Scope (Phase 3)

- Linux support (deferred to Phase 4)
- Mobile or web versions
- Multi-window mode
- Plugin/extension UI
- Collaborative or multi-user features
- Skill marketplace integration (Phase 4)

---

## 11. Technology Summary

| Component | Choice |
|-----------|--------|
| Shell | Electron |
| Renderer | React + Vite |
| Styling | CSS (inline or CSS modules, no heavy framework) |
| CLI communication | JSON-RPC over stdin/stdout |
| Packaging | electron-builder or electron-forge |
| Auto-update | electron-updater |
| Platforms (launch) | macOS, Windows |

---

## 12. Design Reference

The interactive mockup for this design is at:
`designs/option-c-chat.html`

This spec refines that mockup based on the brainstorming session decisions (ambient RSI, labeled tool chips, guided onboarding with templates, workspace picker, command palette navigation).
