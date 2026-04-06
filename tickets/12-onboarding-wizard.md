# Onboarding Wizard

**Phase:** 3.5 — Onboarding
**Type:** Frontend
**Priority:** P0
**Depends on:** 11-settings-overlay
**Repo:** `ouroboros-desktop`

## Context

The first-launch experience is critical for non-technical users. A 3-step wizard guides them through API key setup, workspace selection, and template choice. It should feel warm and welcoming — not like a configuration form.

## Requirements

### Wizard Container

- Full-screen view replacing the chat on first launch
- Centered card (max-width 520px), vertically centered
- Background: `var(--bg-primary)` with subtle pattern or gradient (optional)
- Step indicator: 3 dots at the top showing progress (filled for completed/current, hollow for upcoming)
- "Back" button (for steps 2 and 3). No "Skip wizard" — but individual steps may have skip options.
- Transition between steps: horizontal slide (200ms ease)

### Step 1 — "Connect your AI"

- **Heading:** "Connect your AI" (24px weight 700)
- **Subheading:** "Enter your API key to get started" (15px, `var(--text-secondary)`)
- **Provider selector:** Three large buttons/cards (not a dropdown):
  - Anthropic (with logo/icon)
  - OpenAI (with logo/icon)
  - OpenAI-compatible (with generic icon)
  - Selected provider highlighted with amber border
- **API key input:** Masked text field. Placeholder: "sk-..." or "Enter your API key"
- **Test connection button:** Amber primary button. Calls `config/testConnection` via RPC.
  - Loading: spinner on button
  - Success: green check icon, model dropdown appears populated
  - Failure: red error text below input ("Invalid API key" / "Cannot reach endpoint")
- **Model selector:** Dropdown, only visible after successful connection test
- **Help link:** "Don't have an API key?" — opens external browser to the selected provider's API key page (Anthropic console, OpenAI platform, etc.)
- **Next button:** Disabled until connection test passes and model is selected

### Step 2 — "Choose your workspace"

- **Heading:** "Choose your workspace" (24px weight 700)
- **Subheading:** "Pick a folder for Ouroboros to work in" (15px, `var(--text-secondary)`)
- **Illustration/icon:** Folder illustration (optional, keeps it friendly)
- **Folder picker button:** Large button "Choose folder" — opens native OS folder picker
- **Drag-and-drop zone:** Dashed border area below/around the button. "Or drag a folder here"
- **Selected path display:** After selection, shows folder icon + full path. "Change" link to re-pick.
- **Explanation:** "Ouroboros will read files, run commands, and create skills in this directory."
- **Skip option:** "I'll set this up later" text link below — defaults to home directory
- **Next button:** Enabled when a folder is selected or skipped

### Step 3 — "What would you like to do?"

- **Heading:** "What would you like to do?" (24px weight 700)
- **Subheading:** "Pick a starting point — you can always change later" (15px, `var(--text-secondary)`)
- **Template cards:** 2x2 grid of selectable cards. Each card:
  - Icon or emoji at top
  - Title (16px weight 600)
  - Description (13px, `var(--text-secondary)`, 2-3 lines)
  - Selected card has amber border + subtle amber background tint

| Card | Icon | Title | Description |
|------|------|-------|-------------|
| 1 | Code icon | Help me with a project | "I'll help you build, debug, and improve your code in the workspace you selected." |
| 2 | Search icon | Explore this codebase | "I'll read through your project and give you an overview of its structure and purpose." |
| 3 | Chat icon | General assistant | "Ask me anything — no project focus needed. Good for questions, writing, and research." |
| 4 | Sparkle icon | Let the agent evolve | "I'll learn from every task and build new skills over time. Give me problems to grow from." |

- **Get started button:** Amber primary, enabled when a card is selected. Text: "Get Started"

### Post-Wizard

- Persist onboarding completion flag in electron-store (so wizard never appears again)
- Persist the selected provider, API key (securely), model, and workspace
- If template 4 ("Let the agent evolve") was selected, update RSI config: set `autoReflect: true` and `noveltyThreshold: 0.5` (more aggressive)
- Transition to the chat view with a welcome message from the agent appropriate to the template:
  - Template 1: "Hi! I'm Ouroboros. I'm ready to help with your project at `<workspace>`. What would you like to work on?"
  - Template 2: "Hi! Let me explore `<workspace>` and give you an overview..." (agent auto-runs exploration)
  - Template 3: "Hi! I'm Ouroboros, your AI assistant. Ask me anything."
  - Template 4: "Hi! I'm Ouroboros, and I'm designed to learn and improve. Give me tasks and I'll develop new skills over time. My self-improvement is on — watch the serpent icon for activity."

## Scope Boundaries

- The wizard is the only first-launch UI. There is no "tour" or tooltip walkthrough of the main app.
- Provider logos/icons can be simple SVGs or text labels — no need for official brand assets.
- The wizard does not handle account creation or billing — just API key entry.

## Acceptance Criteria

- [ ] Wizard appears on first launch and does not appear on subsequent launches
- [ ] Step 1: Provider selection, API key input, and test connection work
- [ ] Step 1: Cannot proceed until connection test passes
- [ ] Step 2: Folder picker opens native OS dialog
- [ ] Step 2: Drag-and-drop folder works
- [ ] Step 2: "Skip for now" sets workspace to home directory
- [ ] Step 3: Four template cards are selectable
- [ ] Step 3: "Get Started" transitions to chat with template-appropriate welcome message
- [ ] Template 4 sets aggressive RSI config
- [ ] Back button navigates to previous step
- [ ] Step indicator shows progress
- [ ] API key is stored securely (OS keychain, not plaintext)
- [ ] All settings from wizard persist across restarts

## Feature Tests

- **Test: Full wizard completion**
  - **Setup:** First launch. Complete all 3 steps with valid API key, folder, and template 1.
  - **Expected:** Chat view loads with "Hi! I'm Ouroboros..." welcome message. Settings show correct provider, model, and workspace.

- **Test: Connection test failure**
  - **Setup:** Step 1. Enter invalid API key. Click "Test connection".
  - **Expected:** Red error message. "Next" button stays disabled.

- **Test: Skip workspace**
  - **Setup:** Step 2. Click "I'll set this up later".
  - **Expected:** Proceeds to step 3. Workspace defaults to home directory.

- **Test: Template 4 sets RSI config**
  - **Setup:** Complete wizard with template 4.
  - **Action:** Open settings after wizard.
  - **Expected:** Auto-reflect is on. Novelty threshold is 0.5.

- **Test: Wizard does not reappear**
  - **Setup:** Complete wizard. Quit and relaunch.
  - **Expected:** App opens directly to chat, no wizard.

- **Test: Back navigation**
  - **Setup:** On step 3. Click "Back".
  - **Expected:** Returns to step 2 with previous selection intact.

## Notes

- The wizard steps should share a parent component that manages the current step index and transitions. Each step is a separate child component.
- Use `electron-store` for the onboarding completion flag. Use the main process `safeStorage` API for the API key.
- The welcome messages should be created as the first agent message in the session, not sent as an actual LLM request — they're static template text injected by the app.
- For template 2 ("Explore this codebase"), the app should automatically call `rpc('agent/run', { message: 'Explore this project and give me an overview' })` after the wizard completes.
