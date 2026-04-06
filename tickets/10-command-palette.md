# Command Palette

**Phase:** 3.4 — Navigation & Settings
**Type:** Frontend
**Priority:** P0
**Depends on:** 04-chat-messages
**Repo:** `ouroboros-desktop`

## Context

The command palette is the primary navigation mechanism in the app. There are no menus, no nav bars, no tab strips. Every feature beyond the chat is accessed through Cmd+K. This is inspired by Arc browser, Linear, and VS Code's command palette.

## Requirements

### Modal Component

- **Trigger:** Cmd+K (macOS) / Ctrl+K (Windows). Also accessible via a search icon button in the title bar for discoverability.
- **Position:** Centered horizontally, 20% from the top of the window
- **Width:** 560px (or 100% - 32px on windows narrower than 600px)
- **Background:** `var(--bg-palette)`, border: `1px solid var(--border-light)`, radius: 12px, shadow: `var(--shadow-xl)`
- **Animation:** Fade in (150ms). Fade out on close.
- **Backdrop:** `var(--bg-overlay)` — clicking backdrop closes the palette.
- **Escape** closes the palette. Cmd+K again also closes it (toggle behavior).

### Search Input

- Top of the palette. Full width, no border, 16px font, `var(--text-primary)`.
- Placeholder: "Search actions..."
- Auto-focused on open
- Fuzzy match filtering as the user types. Match against action title and description.
- Divider line below the input: `1px solid var(--border-light)`

### Action List

Grouped sections with headers:

**Actions group:**
| Action | Description | Shortcut | Handler |
|--------|-------------|----------|---------|
| New conversation | Start a fresh session | Cmd+N | `session/new` RPC + clear chat |
| Trigger dream cycle | Run memory consolidation | — | `rsi/dream` RPC |
| Open workspace folder | Change the working directory | — | Native folder picker + `workspace/set` RPC |

**Navigation group:**
| Action | Description | Shortcut | Handler |
|--------|-------------|----------|---------|
| Browse skills | View installed skills | — | Open skills modal/drawer |
| View evolution log | Self-improvement history | — | Open evolution modal |
| Approvals queue | Pending approval requests | — | Open approvals modal |

**Settings group:**
| Action | Description | Shortcut | Handler |
|--------|-------------|----------|---------|
| Change model | Switch LLM provider or model | — | Open settings to model section |
| Configure permissions | Adjust safety tiers | — | Open settings to permissions section |
| Manage API keys | Add or update API keys | — | Open settings to API keys section |
| Appearance | Theme and font size | Cmd+, | Open settings to appearance section |

### Action Item Rendering

Each item shows:
- Icon (16px, `var(--text-secondary)`)
- Title (14px weight 400, `var(--text-primary)`)
- Description (12px, `var(--text-tertiary)`) — right of title or below on narrow items
- Keyboard shortcut hint (11px monospace, `var(--text-tertiary)`) — right-aligned, only for items that have shortcuts

### Keyboard Navigation

- Arrow Up/Down moves selection (highlighted with `var(--bg-hover)`)
- Enter executes the selected action and closes the palette
- Selection wraps around (down from last item goes to first)
- Group headers are not selectable — arrow keys skip them

### Extensibility

The action list should be data-driven (an array of action objects) so future tickets can add items without modifying the palette component. Each action: `{ id, group, icon, title, description, shortcut?, handler }`.

## Scope Boundaries

- The palette only contains the actions listed above. No file search, no "go to line", no command history.
- Skills modal, evolution modal, and approvals modal referenced in handlers can be simple alert/placeholder views initially — full implementations exist in tickets 08 and 09.
- No recent actions or frecency-based sorting — just static groups with fuzzy filtering.

## Acceptance Criteria

- [ ] Cmd+K / Ctrl+K toggles the command palette
- [ ] Search input auto-focuses and filters actions in real-time
- [ ] Fuzzy matching works on action titles and descriptions
- [ ] Three action groups render with headers: Actions, Navigation, Settings
- [ ] Keyboard navigation (arrows, Enter, Escape) works correctly
- [ ] Shortcut hints display for actions that have them
- [ ] Clicking an action executes its handler and closes the palette
- [ ] Clicking the backdrop closes the palette
- [ ] Palette renders correctly on narrow windows (< 600px)
- [ ] Action list is data-driven (easy to extend)

## Feature Tests

- **Test: Open and close**
  - **Setup:** Press Cmd+K.
  - **Expected:** Palette fades in, input focused. Press Escape. Palette fades out.

- **Test: Fuzzy search filtering**
  - **Setup:** Open palette. Type "dream".
  - **Expected:** Only "Trigger dream cycle" action is visible. Other actions filtered out.

- **Test: Keyboard navigation**
  - **Setup:** Open palette. Press Down arrow 3 times. Press Enter.
  - **Expected:** Third action is highlighted, then executed.

- **Test: New conversation action**
  - **Setup:** Open palette. Select "New conversation".
  - **Expected:** `session/new` RPC called. Chat clears. Palette closes.

- **Test: Open workspace action**
  - **Setup:** Select "Open workspace folder".
  - **Expected:** Native folder picker opens.

- **Test: Narrow window layout**
  - **Setup:** Resize window to 500px wide. Open palette.
  - **Expected:** Palette is full width with 16px margins. Still functional.

## Notes

- For fuzzy matching, use a lightweight library like `fuse.js` or a simple substring/includes matcher. Full fuzzy scoring is nice-to-have but not required.
- The palette is rendered in a React portal at the root level.
- Remember to handle the case where the palette is open and the user presses Cmd+K again — it should close (toggle), not try to open a second one.
