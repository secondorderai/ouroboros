# Ouroboros Desktop — Product Requirements Document

**The desktop experience for the first autonomous AI agent that recursively self-improves.**

> Electron Desktop App · Chat-First · Cross-Platform

**Version:** 0.1.0
**Date:** April 06, 2026
**Status:** CONFIDENTIAL — For internal development use
**Parent PRD:** `PRD.md` — Phase 3 (Section 7.3)
**Design Spec:** `docs/superpowers/specs/2026-04-06-electron-desktop-app-design.md`
**Design System:** `DESIGN.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision & Goals](#2-product-vision--goals)
3. [Target Users](#3-target-users)
4. [Architecture](#4-architecture)
5. [JSON-RPC Protocol Specification](#5-json-rpc-protocol-specification)
6. [User Interface](#6-user-interface)
7. [Features & Requirements](#7-features--requirements)
8. [First-Launch Onboarding](#8-first-launch-onboarding)
9. [Security & Privacy](#9-security--privacy)
10. [Performance Requirements](#10-performance-requirements)
11. [Testing Strategy](#11-testing-strategy)
12. [Packaging & Distribution](#12-packaging--distribution)
13. [Development Roadmap](#13-development-roadmap)
14. [Out of Scope](#14-out-of-scope)
15. [References](#15-references)

---

## 1. Executive Summary

Ouroboros Desktop is an Electron application that provides a graphical interface to the Ouroboros CLI agent. It follows the same architecture as the Claude Code desktop app and Codex app: the Electron shell is a pure presentation layer, and all intelligence runs in a CLI child process communicating via JSON-RPC over stdin/stdout.

The app is designed for users who want to experience an autonomous, self-improving AI agent without using a terminal. It ships on macOS and Windows, bundles the CLI internally, and requires zero developer tooling to install.

The UI is chat-first with progressive disclosure. The conversation is always the primary surface. RSI (self-improvement) activity is ambient — a glowing serpent icon and brief inline cards. Everything else (skills browser, evolution log, settings) is one Cmd+K away via the command palette. See `DESIGN.md` for the full visual design system.

---

## 2. Product Vision & Goals

### Vision

Make Ouroboros accessible to anyone curious about autonomous AI — not just developers who live in terminals. The desktop app is the friendly front door to a powerful self-improving agent.

### Goals

| Goal | Metric | Target |
|------|--------|--------|
| Approachable first experience | Time from install to first agent response | < 3 minutes |
| Non-technical usability | Users who complete onboarding without documentation | > 80% |
| Responsive conversation | Time from send to first streamed token visible | < 500ms (network excluded) |
| Reliable operation | App crash rate | < 0.1% of sessions |
| Cross-platform parity | Feature completeness Windows vs macOS | 100% |

### Differentiation from CLI

The CLI remains the power-user tool. The desktop app adds:
- Visual onboarding (wizard with templates)
- Rich markdown rendering with syntax highlighting
- Tool call visualization as compact, expandable chips
- Ambient RSI activity indicator (serpent icon + drawer)
- Command palette for non-keyboard-shortcut-aware users
- File drag-and-drop
- Native workspace folder picker
- System tray presence and auto-update

The desktop app does NOT add new agent capabilities. Every feature is backed by the same CLI functionality — the app is a presentation layer.

---

## 3. Target Users

### Primary: Technical but non-CLI users

Engineers, data scientists, and designers who understand code and AI concepts but prefer a GUI over terminal workflows. They may use VS Code but don't want to learn CLI flags. They want to see their AI agent work in a polished interface.

### Secondary: Non-technical curious users

People who've heard about autonomous AI agents and want to try one. They have an API key (or can get one) but have never used a terminal. They need guided onboarding, plain-language explanations of what the agent is doing, and zero exposure to raw JSON or shell output.

### Non-target

Developers who already use the Ouroboros CLI daily. They can use the CLI directly. The desktop app should not slow them down, but it is not optimized for their workflow.

---

## 4. Architecture

### 4.1 Process Model

```
+-------------------------------------------------------+
|  Electron Main Process                                 |
|                                                        |
|  +---------------+    +------------------------+       |
|  | Window Mgmt   |    | CLI Child Process      |       |
|  | File Dialogs  |    | (Ouroboros CLI)         |       |
|  | Auto-Update   |    |                        |       |
|  | System Tray   |    |  stdin  <-- JSON-RPC   |       |
|  | Single Lock   |    |  stdout --> JSON-RPC   |       |
|  +-------+-------+    +-----------+------------+       |
|          |       IPC Bridge       |                    |
|          +-----------+------------+                    |
+----------------------|-----------------------------+---+
                       |
+----------------------|-----------------------------+---+
|  Electron Renderer Process                             |
|                                                        |
|  +--------------------------------------------------+  |
|  |  React App (Vite)                                |  |
|  |  - Chat view                                     |  |
|  |  - Command palette                               |  |
|  |  - RSI drawer                                    |  |
|  |  - Settings overlay                              |  |
|  |  - Onboarding wizard                             |  |
|  +--------------------------------------------------+  |
+--------------------------------------------------------+
```

**Main process** responsibilities:
- Spawn and manage the CLI child process
- Translate between JSON-RPC (CLI) and IPC (renderer)
- Handle native OS integration: file dialogs, folder pickers, system tray, window management
- Auto-update lifecycle (check, download, prompt restart)
- Single instance enforcement
- API key storage in the OS keychain (macOS Keychain / Windows Credential Manager)

**Renderer process** responsibilities:
- All UI rendering via React + Vite
- State management for conversations, settings, RSI status
- Markdown rendering with syntax highlighting
- Theme management (light/dark, follows system preference)
- Keyboard shortcut handling

**CLI child process:**
- The existing Ouroboros CLI binary, bundled inside the app
- Started with a `--json-rpc` flag that switches output from human-readable to JSON-RPC
- All agent intelligence, tool execution, RSI, memory, and skill management happen here
- The app never calls LLM APIs directly — always through the CLI

### 4.2 CLI Modifications Required

The CLI (at `packages/cli/`) needs one new mode to support the desktop app:

**`--json-rpc` flag:**
- Disables the interactive REPL and terminal rendering
- Reads JSON-RPC requests from stdin
- Writes JSON-RPC responses and notifications to stdout
- Stderr remains available for debug logging
- The CLI process stays alive across multiple conversations (long-running)

This is the only change required to the existing CLI codebase (`packages/cli/src/`) for Phase 3.

### 4.3 State Management

**Renderer state** (React):
- Current conversation messages (in memory)
- UI state: sidebar open/closed, drawer open/closed, theme, active view
- Onboarding completion flag

**Shared types** (`@ouroboros/shared`):
- TypeScript types and interfaces shared between `@ouroboros/cli` and `@ouroboros/desktop` live in `packages/shared/src/`
- Both the CLI and desktop packages import shared types as `@ouroboros/shared`

**Persistent state** (main process, on disk):
- Conversation history (delegated to CLI's SQLite transcript store)
- Settings / `.ouroboros` config (delegated to CLI's config system)
- Window bounds (electron-store or similar)
- Onboarding completed flag (electron-store)

**Principle:** The renderer is stateless across restarts. All durable state lives in the CLI's existing storage (SQLite, `.ouroboros`, `MEMORY.md`) or in minimal Electron-specific preferences (window bounds, onboarding flag).

---

## 5. JSON-RPC Protocol Specification

The protocol wraps the existing `AgentEvent` system in JSON-RPC 2.0 envelopes. The CLI already emits structured events — this protocol serializes them.

### 5.1 Transport

- **Stdin:** Renderer -> CLI. Newline-delimited JSON-RPC requests.
- **Stdout:** CLI -> Renderer. Newline-delimited JSON-RPC responses and notifications.
- **Stderr:** Reserved for debug logging. Not part of the protocol.
- **Encoding:** UTF-8.
- **Framing:** One JSON object per line (NDJSON). No length-prefix headers.

### 5.2 Message Types

#### Requests (Renderer -> CLI)

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `agent/run` | `{ message: string, attachments?: string[] }` | `{ id: string }` | Start a new agent turn. Response is the conversation ID. Events stream as notifications. |
| `agent/cancel` | `{ id: string }` | `{ ok: true }` | Cancel an in-progress agent turn. |
| `session/list` | `{}` | `{ sessions: SessionSummary[] }` | List all conversation sessions. |
| `session/load` | `{ id: string }` | `{ messages: Message[] }` | Load a full conversation by ID. |
| `session/new` | `{ template?: string, workspace?: string }` | `{ id: string }` | Start a new session with optional template context. |
| `session/delete` | `{ id: string }` | `{ ok: true }` | Delete a conversation session. |
| `config/get` | `{}` | `OuroborosConfig` | Get current configuration. |
| `config/set` | `{ path: string, value: unknown }` | `{ ok: true }` | Update a config field (e.g., `model.name`). |
| `config/testConnection` | `{ provider: string, apiKey: string, model?: string }` | `{ ok: boolean, error?: string, models?: string[] }` | Test an API key and return available models. |
| `skills/list` | `{}` | `{ skills: SkillEntry[] }` | List all skills with status. |
| `skills/get` | `{ name: string }` | `{ skill: SkillDetail }` | Get full skill content. |
| `rsi/dream` | `{ mode?: string }` | `{ id: string }` | Trigger dream cycle. Result comes as notification. |
| `rsi/status` | `{}` | `{ active: boolean, stage?: string }` | Get current RSI pipeline status. |
| `evolution/list` | `{ limit?: number, type?: string }` | `{ entries: EvolutionEntry[] }` | Query evolution log. |
| `evolution/stats` | `{}` | `EvolutionStats` | Get evolution summary statistics. |
| `approval/list` | `{}` | `{ pending: ApprovalRequest[] }` | List pending approval requests. |
| `approval/respond` | `{ id: string, decision: 'approve' \| 'deny' }` | `{ ok: true }` | Respond to an approval request. |
| `workspace/set` | `{ path: string }` | `{ ok: true }` | Change the agent's working directory. |

#### Notifications (CLI -> Renderer)

These are JSON-RPC notifications (no `id` field, no response expected). They map directly to the existing `AgentEvent` and `RSIEvent` types.

| Method | Params | Source Event | Description |
|--------|--------|-------------|-------------|
| `agent/text` | `{ text: string }` | `AgentEvent.text` | Streaming text chunk from the agent. |
| `agent/toolCallStart` | `{ toolCallId: string, toolName: string, input: object }` | `AgentEvent.tool-call-start` | Tool execution started. |
| `agent/toolCallEnd` | `{ toolCallId: string, toolName: string, result: unknown, isError: boolean }` | `AgentEvent.tool-call-end` | Tool execution finished. |
| `agent/turnComplete` | `{ text: string, iterations: number }` | `AgentEvent.turn-complete` | Agent finished its response. |
| `agent/error` | `{ message: string, recoverable: boolean }` | `AgentEvent.error` | Agent error. |
| `rsi/reflection` | `{ reflection: ReflectionRecord }` | `RSIEvent.rsi-reflection` | Reflection completed. |
| `rsi/crystallization` | `{ result: CrystallizationResult }` | `RSIEvent.rsi-crystallization` | Crystallization pipeline completed. |
| `rsi/dream` | `{ result: DreamResult }` | `RSIEvent.rsi-dream` | Dream cycle completed. |
| `rsi/error` | `{ stage: string, message: string }` | `RSIEvent.rsi-error` | RSI error (non-fatal). |
| `approval/request` | `{ id: string, description: string, risk: string, diff?: string }` | New | Agent requesting Tier 3/4 approval. |

### 5.3 Example Exchange

```
-> {"jsonrpc":"2.0","id":1,"method":"session/new","params":{"template":"explore","workspace":"/Users/alice/myproject"}}
<- {"jsonrpc":"2.0","id":1,"result":{"id":"sess_abc123"}}

-> {"jsonrpc":"2.0","id":2,"method":"agent/run","params":{"message":"What does this project do?"}}
<- {"jsonrpc":"2.0","id":2,"result":{"id":"turn_def456"}}

<- {"jsonrpc":"2.0","method":"agent/text","params":{"text":"Let me explore "}}
<- {"jsonrpc":"2.0","method":"agent/text","params":{"text":"the project structure..."}}
<- {"jsonrpc":"2.0","method":"agent/toolCallStart","params":{"toolCallId":"tc1","toolName":"bash","input":{"command":"ls -la"}}}
<- {"jsonrpc":"2.0","method":"agent/toolCallEnd","params":{"toolCallId":"tc1","toolName":"bash","result":"total 48\ndrwxr-xr-x...","isError":false}}
<- {"jsonrpc":"2.0","method":"agent/text","params":{"text":"This is a TypeScript project using Bun..."}}
<- {"jsonrpc":"2.0","method":"agent/turnComplete","params":{"text":"Let me explore the project structure...This is a TypeScript project using Bun...","iterations":2}}

<- {"jsonrpc":"2.0","method":"rsi/reflection","params":{"reflection":{"taskSummary":"Explored project structure","novelty":0.1,"generalizability":0.2,"reasoning":"Routine exploration","shouldCrystallize":false}}}
```

### 5.4 Streaming Model

Agent responses stream as a series of `agent/text` notifications, each containing a small chunk of text. The renderer appends chunks to build the full response in real-time. The `agent/turnComplete` notification signals the end and includes the full text for reconciliation.

Tool calls arrive as paired `agent/toolCallStart` and `agent/toolCallEnd` notifications. The renderer can show a spinner between them. The `toolCallId` ties start and end together.

---

## 6. User Interface

The UI design is fully specified in two companion documents:

- **`DESIGN.md`** — Complete design system: colors, typography, components, spacing, elevation, do's and don'ts, responsive behavior, agent prompt guide. Any AI coding agent can read this file to generate consistent UI.
- **`docs/superpowers/specs/2026-04-06-electron-desktop-app-design.md`** — Approved design spec covering app shell, chat experience, RSI drawer, command palette, onboarding wizard, and platform details.
- **`designs/option-c-chat.html`** — Interactive reference mockup.

### UI Summary

| View | Access | Priority |
|------|--------|----------|
| Chat | Default view, always visible | Primary |
| Session sidebar | Hamburger toggle or Cmd+B | Primary |
| Input bar | Fixed bottom, always visible | Primary |
| Command palette | Cmd+K / Ctrl+K | Primary |
| RSI drawer | Click serpent icon (top-right) | Secondary |
| Settings overlay | Cmd+, or via command palette | Secondary |
| Onboarding wizard | First launch only | One-time |

No navigation bars, no tab strips, no activity bars. The command palette is the single entry point to every feature beyond the chat.

---

## 7. Features & Requirements

### 7.1 Chat

| Requirement | Priority | Details |
|-------------|----------|---------|
| Send text messages | P0 | Enter to send, Shift+Enter for newline. Auto-resize 1-5 lines. |
| Stream agent responses | P0 | Append `agent/text` chunks in real-time with blinking cursor. |
| Render markdown | P0 | Full GFM: headings, lists, tables, code blocks (syntax-highlighted), inline code, links, bold/italic. |
| Tool call chips | P0 | Compact pills with human-readable labels. Spinner while running, checkmark when done. Click to expand with syntax-highlighted output. |
| Cancel in-progress turn | P0 | Stop button appears during agent execution. Sends `agent/cancel`. |
| File attachments | P1 | Drag-and-drop or click attachment button. Files passed as paths to the agent. |
| Copy message text | P1 | Click-to-copy button on hover for agent messages. |
| Message retry | P2 | Re-send the last user message if the agent errored. |

### 7.2 Tool Call Visualization

| Requirement | Priority | Details |
|-------------|----------|---------|
| Human-readable labels | P0 | Map tool names to friendly labels: `bash` -> "Ran command", `file-read` -> "Read file", `file-edit` -> "Edited file", `file-write` -> "Created file", `web-fetch` -> "Fetched URL", `web-search` -> "Searched web", `reflect` -> "Reflecting...", `crystallize` -> "Crystallizing skill...". |
| Collapse/expand | P0 | Collapsed by default. Show tool label + status. Expand on click to show input and output. |
| Syntax highlighting | P1 | Code output uses monospace with language-appropriate highlighting. |
| Error display | P0 | Failed tool calls show red status with error message in expanded view. |
| Duration | P2 | Show elapsed time in expanded view header. |

### 7.3 RSI Activity

| Requirement | Priority | Details |
|-------------|----------|---------|
| Serpent status indicator | P0 | Top-right icon. Static (idle), amber pulse (active), flash (skill created). |
| RSI drawer | P0 | Slide-in panel: stats row, recent activity feed, skills list, dream trigger button. |
| Inline RSI cards | P1 | Brief plain-language notification in chat: "Learned a new skill from this task". Dismissable. |
| Reflection notification | P1 | Shown in activity feed. Not shown inline unless it leads to crystallization. |

### 7.4 Skills

| Requirement | Priority | Details |
|-------------|----------|---------|
| Skills list in drawer | P0 | Name + status badge (core/generated/staging) + description on tap. |
| Skills browsing via palette | P1 | Command palette "Browse skills" opens a modal list with search. |
| Skill detail view | P2 | Full SKILL.md content rendered as markdown. |

### 7.5 Approvals

| Requirement | Priority | Details |
|-------------|----------|---------|
| Approval toast | P0 | Non-blocking card: description, risk badge, Approve/Deny buttons. |
| Approval persistence | P0 | Toast persists until user responds. Does not auto-dismiss. |
| Approval queue | P1 | Accessible via command palette "Approvals queue". Lists all pending. |

### 7.6 Sessions

| Requirement | Priority | Details |
|-------------|----------|---------|
| Session sidebar | P0 | Grouped by date. Shows title, time, message count. |
| New conversation | P0 | Cmd+N or button in sidebar. |
| Load conversation | P0 | Click session in sidebar to reload its history. |
| Delete conversation | P2 | Right-click or swipe to delete with confirmation. |
| Session title | P1 | Auto-generated from first user message. Truncated to 50 chars. |

### 7.7 Workspace

| Requirement | Priority | Details |
|-------------|----------|---------|
| Folder picker | P0 | Native OS folder dialog. Indicator in input bar shows current path. |
| Change workspace | P0 | Click workspace indicator to pick a new folder. Sends `workspace/set`. |
| Drag-and-drop folder | P1 | Drop a folder onto the app to set it as workspace. |

### 7.8 Settings

| Requirement | Priority | Details |
|-------------|----------|---------|
| Model & API keys | P0 | Provider selector, API key input (masked), model dropdown, test connection button. |
| Permissions | P1 | Toggle switches for each tier (0-4). Tier 3/4 require confirmation. |
| RSI behavior | P1 | Auto-reflect toggle, novelty threshold slider (0.0-1.0). |
| Memory | P1 | Consolidation schedule selector: session-end, daily, manual. |
| Appearance | P0 | Theme: light, dark, system. Font size: small, medium, large. |
| Workspace defaults | P2 | Default folder path for new conversations. |

### 7.9 Command Palette

| Requirement | Priority | Details |
|-------------|----------|---------|
| Open/close | P0 | Cmd+K / Ctrl+K to toggle. Escape to close. |
| Fuzzy search | P0 | Filter all actions by typed query. |
| Action groups | P0 | Actions, Navigation, Settings — each with icon, title, description. |
| Keyboard navigation | P0 | Arrow keys to move, Enter to select. |
| Shortcut hints | P1 | Right-aligned keyboard shortcut text on items that have them. |

---

## 8. First-Launch Onboarding

A 3-step wizard presented as a centered card UI. Appears only on first launch.

### Step 1 — "Connect your AI"

- Provider selector: Anthropic, OpenAI, OpenAI-compatible
- API key input (masked) with "Test connection" button
- On success: model dropdown populates with available models
- On failure: clear error message ("Invalid API key" / "Cannot reach endpoint")
- Help link: "Don't have an API key?" opens external browser to provider's API key page
- **Validation:** Cannot proceed until connection test passes

### Step 2 — "Choose your workspace"

- "Choose folder" button opens native OS folder picker
- Drag-and-drop zone as alternative
- Selected path displayed with folder icon
- Explanation text: "This is the directory Ouroboros will work in"
- "Skip for now" link — defaults to user's home directory
- **Validation:** Any valid directory path, or skip

### Step 3 — "What would you like to do?"

Four template cards in a 2x2 grid:

| Template | Description | Agent Behavior |
|----------|-------------|----------------|
| Help me with a project | "I'll help you build, debug, and improve your code" | Opens chat, agent introduces itself and asks what you need |
| Explore this codebase | "I'll read your project and give you an overview" | Agent immediately reads workspace structure and files |
| General assistant | "Ask me anything — no project focus needed" | Standard chat, no workspace context injected |
| Let the agent evolve | "I'll learn from every task and build new skills" | Aggressive RSI settings (auto-reflect, low threshold), agent explains its learning process |

**After wizard:** Drops into chat with the template's welcome message. Wizard state persisted in electron-store so it never appears again. All settings remain editable via Cmd+,.

---

## 9. Security & Privacy

### 9.1 API Key Storage

- API keys are stored in the OS secure credential store:
  - **macOS:** Keychain via `keytar` or Electron's `safeStorage`
  - **Windows:** Credential Manager via `keytar` or Electron's `safeStorage`
- Keys are never written to disk in plaintext
- Keys are never included in logs or error reports
- The renderer process never has direct access to keys — the main process mediates

### 9.2 File System Access

- The CLI child process has full access to the workspace directory (Tier 1 permissions)
- File access outside the workspace follows the CLI's existing permission model (Tier 3/4 for system-level)
- The Electron renderer has no direct filesystem access — all file operations go through the CLI

### 9.3 Network Access

- The main process makes HTTPS requests only to:
  - LLM API endpoints (Anthropic, OpenAI, or configured base URL)
  - Auto-update server (GitHub Releases or configured endpoint)
- No telemetry, no analytics, no phoning home
- The CLI's existing WebFetchTool and WebSearchTool handle agent-initiated web requests through the CLI process, not the Electron main process

### 9.4 Renderer Sandbox

- Context isolation: enabled (renderer cannot access Node.js APIs directly)
- Node integration: disabled in renderer
- All IPC goes through a preload script with a whitelisted API surface
- No dynamic code execution in the renderer
- No remote module, no webview tags

### 9.5 Content Security Policy

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self';
```

No external scripts, no CDN resources. Everything is bundled.

---

## 10. Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| App cold start | < 2 seconds | From double-click to window visible with content |
| CLI spawn | < 500ms | From app ready to CLI process responding to first JSON-RPC ping |
| First token visible | < 500ms | From send click to first `agent/text` chunk rendered (excluding network RTT to LLM) |
| Streaming render | 60fps | No frame drops during text streaming at normal LLM output speeds |
| Memory baseline | < 200MB | Electron + React app with one active conversation |
| Memory ceiling | < 500MB | After 10+ conversations with long histories |
| Bundle size | < 100MB | Compressed installer (excluding bundled CLI binary) |

### Performance Principles

- **Virtualize long conversations.** Only render messages in the viewport. Use a virtual scroll library for conversations with 100+ messages.
- **Debounce streaming renders.** Batch incoming `agent/text` chunks and flush to DOM at most once per animation frame (16ms). Do not re-render on every chunk.
- **Lazy load views.** Settings, RSI drawer, and command palette components are code-split and loaded on first access.
- **No external network requests at render time.** All fonts are system fonts. All icons are bundled SVGs. No CDN.

---

## 11. Testing Strategy

### 11.1 Unit Tests

- **Scope:** React components, state management, utility functions, protocol serialization/deserialization
- **Runner:** Vitest (aligned with Vite)
- **Coverage target:** 80% of renderer source
- **Key areas:**
  - Message rendering (markdown, code blocks, tool chips)
  - Command palette search/filtering
  - JSON-RPC message parsing and construction
  - Theme switching logic
  - Onboarding state machine

### 11.2 Integration Tests

- **Scope:** Main process <-> CLI communication, IPC bridge
- **Approach:** Spawn a mock CLI process that speaks JSON-RPC, verify the main process correctly relays messages to the renderer
- **Key areas:**
  - CLI spawn and graceful shutdown
  - Request/response round-trip
  - Notification streaming
  - Error handling (CLI crash, malformed JSON, timeout)

### 11.3 End-to-End Tests

- **Tool:** Playwright with Electron support (`@playwright/test` with `electron.launch()`)
- **Scope:** Full user flows from app launch through interaction
- **Key flows:**
  - Complete onboarding wizard (3 steps)
  - Send a message and receive a streamed response
  - Expand and collapse a tool call chip
  - Open and search the command palette
  - Toggle sidebar, open RSI drawer
  - Switch themes
  - Change workspace folder

### 11.4 Manual Testing Matrix

Before each release, verify on:

| Platform | Version | Test |
|----------|---------|------|
| macOS | Ventura (13), Sonoma (14), Sequoia (15) | Full E2E suite + visual check |
| Windows | 10 (21H2+), 11 (23H2+) | Full E2E suite + visual check |

Visual checks: theme rendering, window chrome, system font rendering, file dialog behavior, tray icon.

---

## 12. Packaging & Distribution

### 12.1 Build Tooling

- **Bundler:** electron-builder (or electron-forge if easier for the chosen project structure)
- **App signing:**
  - macOS: Apple Developer ID certificate + notarization via `notarytool`
  - Windows: EV code signing certificate
- **CLI bundling:** The Ouroboros CLI (`packages/cli/`) is compiled with `bun build --compile` to a standalone binary and included in the app's `resources/` directory
- **Desktop source:** All Electron app source lives in `packages/desktop/`

### 12.2 Artifacts

| Platform | Format | Notes |
|----------|--------|-------|
| macOS | `.dmg` (universal: arm64 + x64) | Drag-to-Applications install |
| Windows | `.exe` (NSIS installer) | Standard setup wizard |
| Windows | `.zip` (portable) | No install required |

### 12.3 Auto-Update

- **Mechanism:** electron-updater with GitHub Releases as the update server
- **Flow:**
  1. App checks for updates on launch (non-blocking)
  2. If update available, downloads in background
  3. Shows a non-intrusive notification: "Update available. Restart to apply."
  4. User chooses when to restart
- **Frequency:** Check once per app launch, max once per 24 hours
- **Rollback:** If the new version crashes on startup 3 times, offer to reinstall the previous version

### 12.4 Versioning

- Follows semver: `MAJOR.MINOR.PATCH`
- Version is independent of the CLI version (they can release at different cadences)
- The app declares a minimum compatible CLI version in its config

---

## 13. Development Roadmap

Phase 3 is broken into 6 sub-phases, each producing a testable increment.

### 3.1 — Project Scaffolding (Week 1-2)

- Scaffold Electron + React + Vite app in `packages/desktop/`
- Set up electron-builder configuration for macOS and Windows
- Implement IPC bridge (main <-> renderer preload script)
- Create the app shell: window, title bar, basic layout
- Implement theme system (light/dark/system) per DESIGN.md
- Add `--json-rpc` mode to the CLI (`packages/cli/`)
- Set up shared types in `packages/shared/` for cross-package interfaces

**Deliverable:** Empty app window with correct styling, theme toggle works, CLI spawns and responds to a ping.

### 3.2 — Chat Core (Week 3-4)

- Implement JSON-RPC client in main process
- Build chat message list with virtual scrolling
- Implement streaming text rendering (batched at animation frame)
- Markdown renderer with syntax highlighting
- Tool call chip component (collapsed/expanded states)
- Input bar with auto-resize, send, cancel
- Session management: new, load, list, sidebar

**Deliverable:** Fully functional chat. User can send messages, see streamed responses with tool calls, manage multiple conversations.

### 3.3 — RSI & Skills (Week 5-6)

- Ouroboros serpent status indicator with animation states
- RSI drawer: stats, activity feed, skills list
- RSI notification cards (inline in chat)
- Approval toast component
- Wire RSI events from CLI notifications to UI components

**Deliverable:** RSI activity is visible. Approvals work. Skills are browsable in the drawer.

### 3.4 — Command Palette & Settings (Week 7)

- Command palette: modal, fuzzy search, grouped actions, keyboard navigation
- Settings overlay: all sections per requirements
- Keyboard shortcut system (Cmd+K, Cmd+N, Cmd+B, Cmd+,, Escape)
- Workspace folder picker integration

**Deliverable:** Full navigation via command palette. All settings configurable. Keyboard-driven workflow complete.

### 3.5 — Onboarding & Polish (Week 8)

- 3-step onboarding wizard
- Template-based first conversation
- API key testing flow
- API key secure storage (keychain/credential manager)
- File drag-and-drop for attachments and workspace
- Loading states, empty states, error states
- Animations: sidebar slide, drawer slide, palette fade, toast slide

**Deliverable:** Complete first-run experience. Polished transitions and edge cases.

### 3.6 — Packaging & Release (Week 9-10)

- Code signing setup (macOS + Windows)
- electron-builder configuration for all artifacts
- Auto-update implementation and testing
- CLI binary bundling into app resources
- E2E test suite with Playwright
- Manual testing on macOS and Windows
- Performance profiling and optimization

**Deliverable:** Signed, distributable installers for macOS and Windows. Auto-update functional. All tests passing.

---

## 14. Out of Scope

These are explicitly deferred beyond Phase 3:

| Item | Deferred To | Reason |
|------|-------------|--------|
| Linux support | Phase 4 | Reduces testing matrix at launch |
| Mobile or web versions | Phase 4+ | Different platforms, different UX |
| Multi-window mode | Phase 4 | Single window + sidebar is sufficient for launch |
| Plugin/extension UI | Phase 4 | CLI plugin system doesn't exist yet |
| Skill marketplace integration | Phase 4 | Marketplace doesn't exist yet |
| Collaborative/multi-user features | Phase 4+ | Single-user product for now |
| Embedded terminal | Not planned | This is a GUI alternative to the terminal, not a terminal wrapper |
| Custom themes beyond light/dark | Phase 4 | Two themes is sufficient for launch |
| Offline mode | Not planned | The agent requires an LLM API connection |
| Voice input/output | Phase 4+ | Text-first for now |

---

## 15. References

| Document | Path | Description |
|----------|------|-------------|
| Parent PRD | `PRD.md` | Full Ouroboros product specification. Phase 3 (Section 7.3) defines the desktop app at a high level. |
| Design Spec | `docs/superpowers/specs/2026-04-06-electron-desktop-app-design.md` | Approved UI design spec from brainstorming session. |
| Design System | `DESIGN.md` | Complete visual design system in Google Stitch DESIGN.md format. Machine-readable design tokens. |
| Interactive Mockup | `designs/option-c-chat.html` | HTML mockup of the chat-first UI direction. |
| Agent Events | `packages/cli/src/agent.ts` (`AgentEvent` type) | Existing event types that the JSON-RPC protocol wraps. |
| RSI Events | `packages/cli/src/rsi/types.ts` (`RSIEvent` type) | RSI event types emitted by the orchestrator. |
| Config Schema | `packages/cli/src/config.ts` (`configSchema`) | Zod schema for `.ouroboros` configuration. |
| CLI Entry Point | `packages/cli/src/cli.ts` | CLI that will receive the `--json-rpc` flag. |
| Shared Types | `packages/shared/src/` | Shared TypeScript types used by both CLI and desktop. |
| Desktop App | `packages/desktop/src/` | Electron desktop application source. |

---

*End of specification. This document, together with DESIGN.md and the design spec, provides everything needed to implement the Ouroboros desktop application.*
