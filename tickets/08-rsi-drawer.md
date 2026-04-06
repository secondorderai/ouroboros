# RSI Status Indicator & Drawer

**Phase:** 3.3 — RSI & Skills
**Type:** Frontend
**Priority:** P0
**Depends on:** 03-ipc-bridge
**Repo:** `packages/desktop/`

## Context

RSI (Recursive Self-Improvement) is what makes Ouroboros unique, but it should be ambient — never interrupting the conversation. The serpent status indicator and slide-in drawer give users visibility into the agent's self-improvement activity without cluttering the chat.

## Requirements

### Serpent Status Indicator

Located in the title bar, top-right. A small SVG icon (~24px) of the Ouroboros serpent/infinity symbol.

| State | Appearance | Trigger |
|-------|------------|---------|
| Idle | Static, `var(--text-tertiary)` color | Default state |
| RSI Active | Amber pulse glow animation (2s infinite) | Any `rsi/*` notification received |
| Skill Crystallized | Brief amber flash (1s), then back to idle | `rsi/crystallization` with `outcome: 'promoted'` |

- Tooltip on hover shows current state: "Idle", "Reflecting on task...", "Skill crystallized!"
- Click opens the RSI drawer

### RSI Drawer

Slides in from the right edge, 350px wide (or 90% on narrow windows). Background: `var(--bg-drawer)`, border-left: `1px solid var(--border-light)`, shadow: `var(--shadow-lg)`.

Animation: 200ms ease slide. Overlay on top of chat content (does not push it).

**Drawer sections:**

1. **Header:** "Self-Improvement" title (18px weight 600) + close button (icon button, X)

2. **Stats row:** 4-column grid:
   - Total skills (number, from `skills/list`)
   - Generated (self-made count, filter by status)
   - Sessions analyzed (from `evolution/stats`)
   - Success rate (from `evolution/stats`)
   - Each stat: number at 24px weight 700 on top, label at 11px weight 400 `var(--text-secondary)` below

3. **Recent activity feed:** Scrollable list of recent RSI events in plain language. Max 20 items. Each item:
   - Plain text description (13px)
   - Relative timestamp (12px, `var(--text-tertiary)`)
   - Examples:
     - "Reflected on file parsing task — no new skill needed"
     - "Crystallized: `bun-stream-parser` — passed 2/2 tests"
     - "Memory consolidated — merged 3 topics"
     - "RSI error in reflection: API timeout"

4. **Skills list:** Scrollable list of all skills. Each item:
   - Name (14px weight 500)
   - Status badge right-aligned (Core = blue, Generated = amber, Staging = gray)
   - Click to expand: description text (13px, `var(--text-secondary)`)

5. **Dream trigger:** Button at the bottom of the drawer: "Run dream cycle" (secondary/ghost button). Calls `rsi/dream` via RPC. Shows a spinner while running, then updates the activity feed with the result.

### Data Loading

- On drawer open: call `skills/list`, `evolution/stats`, and `evolution/list` (limit 20) in parallel
- Cache results for 30 seconds to avoid hammering the CLI on repeated open/close
- RSI notifications (`rsi/reflection`, `rsi/crystallization`, `rsi/dream`, `rsi/error`) update the activity feed in real-time when the drawer is open

### Inline RSI Cards (in chat)

When a `rsi/crystallization` notification arrives with `outcome: 'promoted'`, insert a brief inline card in the chat:

- Background: `var(--bg-rsi-card)` (amber gradient)
- Left border: 3px solid `var(--accent-amber)`
- Text: "Learned a new skill: `<skill-name>`" (14px)
- Dismissable with X button
- Radius: 10px, padding: 12px 16px

Other RSI events (reflection with no crystallization, errors) are NOT shown inline — only in the drawer's activity feed.

## Scope Boundaries

- Skill detail view (full SKILL.md content) is P2 — just show name, badge, and description
- Evolution charts/graphs are out of scope — just the stats row and text feed
- Skill enable/disable toggles are out of scope

## Acceptance Criteria

- [ ] Serpent icon is visible in the title bar and clickable
- [ ] Icon is static gray when idle, pulses amber during RSI activity
- [ ] Icon flashes amber briefly when a skill is crystallized
- [ ] Click opens the RSI drawer with 200ms slide animation
- [ ] Drawer shows stats row with real data from the CLI
- [ ] Activity feed shows recent RSI events in plain language
- [ ] Skills list shows all skills with status badges
- [ ] Clicking a skill expands to show its description
- [ ] Dream trigger button calls `rsi/dream` and shows result
- [ ] Inline RSI card appears in chat when a skill is promoted
- [ ] Drawer data loads on open and caches for 30 seconds
- [ ] RSI notifications update the activity feed in real-time

## Feature Tests

- **Test: Serpent pulses on RSI activity**
  - **Setup:** Mock CLI sends `rsi/reflection` notification.
  - **Expected:** Serpent icon transitions from gray to amber pulse animation.

- **Test: Drawer opens and shows data**
  - **Setup:** Click the serpent icon.
  - **Expected:** Drawer slides in. Stats row shows numbers. Activity feed shows entries. Skills list populated.

- **Test: Dream trigger**
  - **Setup:** Open drawer. Click "Run dream cycle".
  - **Expected:** Button shows spinner. After `rsi/dream` response, spinner stops. New entry appears in activity feed.

- **Test: Inline crystallization card**
  - **Setup:** Mock CLI sends `rsi/crystallization` with `outcome: 'promoted'`, `skillName: 'csv-parser'`.
  - **Expected:** Inline card appears in chat: "Learned a new skill: csv-parser" with amber styling.

- **Test: Skills list with badges**
  - **Setup:** Mock CLI returns 3 core skills and 2 generated skills.
  - **Expected:** 5 skills listed. Core skills have blue badge, generated have amber badge.

## Notes

- The serpent SVG should be a simple path — either a stylized infinity symbol or a minimal ouroboros. Keep it under 1KB.
- For the amber pulse animation, use CSS `@keyframes` with `box-shadow` or `filter: drop-shadow()` — not opacity, which would make the icon invisible during the animation.
- The activity feed translates RSI event data to plain language in the renderer — the CLI sends structured data, the UI humanizes it.
