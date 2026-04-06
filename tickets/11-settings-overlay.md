# Settings Overlay

**Phase:** 3.4 — Navigation & Settings
**Type:** Frontend
**Priority:** P0
**Depends on:** 03-ipc-bridge
**Repo:** `packages/desktop/`

## Context

Settings is where users configure their model, API keys, permissions, RSI behavior, and appearance. It opens as a full-screen overlay (not a separate window) accessible via Cmd+, or the command palette.

## Requirements

### Overlay Container

- Full-screen overlay on top of the chat (not a modal — takes up the whole content area)
- Background: `var(--bg-primary)`
- Close button (X icon) top-right. Escape also closes.
- Animation: fade in 150ms
- Centered content card, max-width 640px
- Scrollable if content exceeds viewport height

### Settings Sections

#### Model & API Keys (P0)

- **Provider selector:** Dropdown: Anthropic, OpenAI, OpenAI-compatible
- **API key input:** Masked text input (shows dots). "Show" toggle to reveal. Key stored securely via main process (OS keychain).
- **Model selector:** Dropdown populated after API key is validated. Shows available models for the selected provider.
- **Test connection button:** Calls `config/testConnection` via RPC. Shows success (green check + model list) or failure (red error message).
- **Base URL input:** Only visible when provider is "OpenAI-compatible". Text input for the custom endpoint.
- All changes call `config/set` via RPC to persist immediately.

#### Appearance (P0)

- **Theme:** Three-option selector: Light, Dark, System. Applies immediately.
- **Font size:** Three-option selector: Small (13px body), Medium (15px body, default), Large (17px body). Applies immediately.

#### Permissions (P1)

- **5 toggle switches**, one per tier:
  - Tier 0: Read-only (always on, disabled toggle)
  - Tier 1: Scoped writes (default on)
  - Tier 2: Skill generation (default on)
  - Tier 3: Self-modification (default off) — shows warning when enabling
  - Tier 4: System-level (default off) — shows warning when enabling
- Tiers 3 and 4 show a confirmation dialog when toggled on: "This allows the agent to [description]. Are you sure?"

#### RSI Behavior (P1)

- **Auto-reflect toggle:** On/off. Default on. When off, the agent will not automatically reflect after tasks.
- **Novelty threshold slider:** Range 0.0 to 1.0, step 0.1. Default 0.7. Shows current value. Label explains: "Lower = more skills generated, higher = only very novel patterns."
- Both call `config/set` to persist.

#### Memory (P1)

- **Consolidation schedule:** Three-option selector: Session-end, Daily, Manual
- Explanation text for each option

#### Workspace Defaults (P2)

- **Default workspace folder:** Path display + "Change" button (opens folder picker)
- Used when creating new conversations without an explicit workspace

### Layout

Left side: section navigation (vertical list of section names). Right side: active section content. Clicking a section name scrolls to / shows that section. Active section is highlighted in the nav.

On narrow windows (< 600px): nav becomes a horizontal tab bar above the content.

## Scope Boundaries

- API key encryption/decryption is handled by the main process via `safeStorage` — the renderer just sends and receives masked values
- No "Export settings" or "Import settings" functionality
- No per-conversation settings (settings are global)

## Acceptance Criteria

- [ ] Settings overlay opens via Cmd+, / Ctrl+, or command palette
- [ ] Escape or close button dismisses the overlay
- [ ] Provider selector, API key input, and model dropdown work correctly
- [ ] "Test connection" validates the key and populates available models
- [ ] Theme selector switches theme immediately (light/dark/system)
- [ ] Font size selector changes body text size immediately
- [ ] Permission toggles update config with confirmation for Tier 3/4
- [ ] RSI auto-reflect and novelty threshold controls work and persist
- [ ] Memory consolidation schedule selector works and persists
- [ ] All changes persist via `config/set` RPC (no "Save" button — instant apply)
- [ ] Section navigation highlights the active section

## Feature Tests

- **Test: Change theme**
  - **Setup:** Open settings. Select "Dark" theme.
  - **Expected:** App switches to dark theme immediately. Setting persists after restart.

- **Test: API key validation**
  - **Setup:** Enter an API key. Click "Test connection".
  - **Expected:** On success: green check, model dropdown populates. On failure: red error message.

- **Test: Permission tier warning**
  - **Setup:** Toggle Tier 3 on.
  - **Expected:** Confirmation dialog appears. Accept: toggle turns on. Cancel: toggle stays off.

- **Test: Novelty threshold slider**
  - **Setup:** Drag slider to 0.5.
  - **Expected:** Label shows 0.5. `config/set` called with `rsi.noveltyThreshold = 0.5`.

- **Test: Settings persist**
  - **Setup:** Change model, theme, and RSI threshold. Quit and relaunch.
  - **Expected:** All settings restored to the values set.

## Notes

- API key handling in the renderer: the renderer sends the raw key to the main process via IPC for storage. The main process encrypts via `safeStorage` and stores the encrypted blob. On load, the main process decrypts and passes the key to the CLI via the JSON-RPC `config/set` call. The renderer never persists the key itself.
- Use radio button groups or segmented controls for the 3-option selectors (theme, font size, consolidation schedule) — dropdown is overkill for 3 options.
- The instant-apply pattern (no save button) means every change triggers an RPC call. Debounce the slider by 300ms to avoid flooding the CLI with threshold updates.
