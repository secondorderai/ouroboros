# Design System: Ouroboros

## 1. Visual Theme & Atmosphere

Ouroboros is a chat-first autonomous AI agent desktop app. The visual language is warm, clean, and approachable — designed for non-technical users and technical-but-GUI-preferring users who want to experience an AI that improves itself. The aesthetic draws from Claude.ai's generous whitespace and warm neutrals, Linear's precision and restraint, and Arc's command-palette-driven navigation.

The light theme uses warm off-whites and cream tones that feel organic and inviting — not the cold blue-grays of developer tools. The dark theme mirrors this warmth with amber-tinted dark surfaces rather than pure blacks. Amber is the signature accent color, evoking the Ouroboros serpent and the warmth of self-improvement. It appears only on interactive elements, RSI activity indicators, and the primary send action — never decoratively.

Typography uses the system font stack for speed and native feel, with Inter as the preferred web fallback. Text is set in clean sans-serif at comfortable sizes optimized for reading conversations. Monospace is reserved strictly for code blocks and tool output. The overall density is low: generous padding, breathing room between messages, and progressive disclosure that hides complexity until requested.

**Key Characteristics:**
- Warm neutral palette: off-white backgrounds (`#FAFAF8`), cream message bubbles (`#F4F0EB`), warm dark mode (`#1A1A1E`)
- Amber accent: `#D97706` (primary), `#F59E0B` (light/hover) — the only chromatic accent in the core UI
- System font stack with Inter fallback — native feel on every platform
- Chat-first layout: conversation is always the primary surface
- Progressive disclosure: minimal by default, details on demand (command palette, drawers, expandable chips)
- Low information density: generous whitespace, comfortable font sizes, relaxed line heights
- Dual theme: light (default) and dark, both warm-toned

## 2. Color Palette & Roles

### Light Theme

#### Background Surfaces
- **Primary** (`#FAFAF8`): Main app background. Warm off-white with a barely perceptible yellow undertone.
- **Secondary** (`#F2F1EE`): Sidebar background, section dividers. One step darker.
- **Tertiary** (`#E8E7E3`): Borders, divider lines, subtle separators.
- **Chat** (`#FFFFFF`): Chat area background. Pure white for maximum readability of conversation.
- **Input** (`#FFFFFF`): Input field backgrounds.
- **User Message** (`#F4F0EB`): User message bubble background. Warm cream — distinct from agent messages.
- **Tool Chip** (`#F6F5F2`): Collapsed tool call chip background.
- **Tool Expanded** (`#FAFAF8`): Expanded tool call detail background.
- **RSI Card** (`linear-gradient(135deg, #FFF8F0 0%, #FFF5E8 100%)`): RSI notification card. Warm amber-tinted gradient.
- **Sidebar** (`#F7F6F3`): Session sidebar background.
- **Sidebar Active** (`#EDECEA`): Active/selected session item.
- **Hover** (`rgba(0,0,0,0.04)`): Universal hover state overlay.
- **Overlay** (`rgba(0,0,0,0.3)`): Modal/drawer backdrop.

#### Text
- **Primary** (`#1A1A1A`): Headings, agent message body, user input. Near-black for strong contrast.
- **Secondary** (`#6B6B6B`): Body text, descriptions, session metadata. Mid-gray.
- **Tertiary** (`#9B9B9B`): Timestamps, placeholders, de-emphasized content. Light gray.
- **Inverse** (`#FFFFFF`): Text on amber buttons or dark surfaces.

#### Border
- **Light** (`#E8E7E3`): Default borders — sidebar edges, input outlines, card dividers.
- **Medium** (`#D4D3CF`): Stronger borders for emphasis — focused inputs, active sections.

#### Accent & Status
- **Amber** (`#D97706`): Primary interactive accent. Send button, RSI glow, active indicators, links.
- **Amber Light** (`#F59E0B`): Hover state for amber elements. Status indicator pulse.
- **Amber Background** (`rgba(217,119,6,0.08)`): Subtle amber tint for RSI-related backgrounds.
- **Green** (`#16A34A`): Success states. Tool call completed, tests passed, skill promoted.
- **Blue** (`#2563EB`): Informational. Links in agent messages, core skill badges.
- **Purple** (`#7C3AED`): Generated skill badges, evolution events.
- **Red** (`#DC2626`): Error states, destructive actions, denied approvals.
- **Orange** (`#EA580C`): Warning states, staging skill badges.

### Dark Theme

#### Background Surfaces
- **Primary** (`#1A1A1E`): Main app background. Warm dark gray, not pure black.
- **Secondary** (`#222226`): Elevated panels, drawer background.
- **Tertiary** (`#2C2C30`): Higher elevation — dropdown menus, popovers.
- **Chat** (`#1E1E22`): Chat area. Slightly lighter than primary for subtle depth.
- **Input** (`#2A2A2E`): Input field backgrounds.
- **User Message** (`#2A2720`): User bubble. Warm amber-dark tint.
- **Tool Chip** (`#28282C`): Collapsed tool chip.
- **Tool Expanded** (`#222226`): Expanded tool detail.
- **RSI Card** (`linear-gradient(135deg, #2A2518 0%, #2C2418 100%)`): RSI card with amber warmth.
- **Sidebar** (`#1A1A1E`): Matches primary.
- **Sidebar Active** (`#28282C`): Selected session.
- **Hover** (`rgba(255,255,255,0.06)`): Universal hover overlay.
- **Overlay** (`rgba(0,0,0,0.6)`): Darker overlay for modals on dark backgrounds.

#### Text (Dark)
- **Primary** (`#ECECEC`): Headings and body. Not pure white — prevents eye strain.
- **Secondary** (`#9B9B9B`): Descriptions, metadata.
- **Tertiary** (`#6B6B6B`): Placeholders, timestamps.
- **Inverse** (`#1A1A1A`): Text on light or amber surfaces.

#### Border (Dark)
- **Light** (`#333337`): Default borders.
- **Medium** (`#444448`): Emphasized borders.

#### Accent (Dark) — same hues, adjusted opacity
- **Amber Background** (`rgba(217,119,6,0.12)`): Slightly more opaque for visibility on dark.
- **Amber Glow** (`rgba(245,158,11,0.5)`): RSI pulse animation glow.
- All other accent colors remain unchanged between themes.

## 3. Typography Rules

### Font Families
- **Sans (primary)**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif` — system font stack for native performance. Inter is the preferred fallback on systems without platform fonts.
- **Monospace**: `'SF Mono', 'Fira Code', 'Consolas', monospace` — used only for code blocks, tool call output, and technical metadata.

### Hierarchy

| Role | Font | Size | Weight | Line Height | Use |
|------|------|------|--------|-------------|-----|
| Page Title | Sans | 24px | 700 | 1.0 | Onboarding wizard headings |
| Section Header | Sans | 18px | 600 | 1.5 | Drawer headers, settings sections |
| Agent Name | Sans | 14px | 600 | 1.5 | "Ouroboros" label above agent messages |
| Body | Sans | 15px | 400 | 1.6 | Agent message text, descriptions |
| Body Medium | Sans | 15px | 500 | 1.6 | Session titles, skill names |
| Body Small | Sans | 14px | 400 | 1.5 | Secondary body text, drawer content |
| Input | Sans | 15px | 400 | 1.6 | User text input |
| Tool Chip Label | Sans | 13px | 500 | 1.5 | "Read file", "Ran command" chips |
| Caption | Sans | 12px | 400 | 1.5 | Timestamps, message metadata |
| Badge | Sans | 11px | 600 | 1.0 | Status badges, skill type labels |
| Micro | Sans | 10px | 500 | 1.0 | Keyboard shortcut hints, counters |
| Code Block | Mono | 13px | 400 | 1.5 | Syntax-highlighted code in messages |
| Code Inline | Mono | 13px | 400 | 1.5 | Inline code spans |
| Tool Output | Mono | 12px | 400 | 1.5 | Expanded tool call stdout/stderr |

### Principles
- **System fonts first**: The app should feel native on macOS and Windows. No web-font loading delay.
- **Comfortable reading sizes**: Chat body at 15px, not the 13-14px typical of developer tools. This audience reads conversations, not code.
- **Monospace only for code**: Never use monospace for UI labels, buttons, or navigation. Agent responses are prose, not terminal output.
- **Weight restraint**: Three weights — 400 (reading), 500 (emphasis), 600 (headings/badges). 700 only for onboarding.

## 4. Component Stylings

### Buttons

**Primary (Amber)**
- Background: `#D97706`
- Text: `#FFFFFF`, 14px weight 500
- Padding: 8px 16px
- Radius: 6px
- Hover: `#F59E0B`
- Use: Send message, confirm actions, primary onboarding CTAs

**Secondary (Ghost)**
- Background: transparent
- Text: `var(--text-primary)`, 14px weight 500
- Padding: 8px 16px
- Radius: 6px
- Border: `1px solid var(--border-light)`
- Hover: `var(--bg-hover)`
- Use: Cancel, secondary actions, drawer buttons

**Danger**
- Background: `#DC2626`
- Text: `#FFFFFF`, 14px weight 500
- Padding: 8px 16px
- Radius: 6px
- Hover: `#B91C1C`
- Use: Deny approval, destructive actions

**Icon Button**
- Background: transparent
- Text: `var(--text-secondary)`
- Padding: 6px
- Radius: 6px
- Hover: `var(--bg-hover)`, text lightens to `var(--text-primary)`
- Use: Sidebar toggle, theme toggle, attachment, close buttons

### Chat Messages

**User Message Bubble**
- Background: `var(--bg-user-msg)`
- Text: `var(--text-primary)`, 15px weight 400
- Padding: 12px 16px
- Radius: 16px 16px 4px 16px (flat bottom-right corner indicates sender)
- Max width: 80% of chat area
- Alignment: right

**Agent Message**
- Background: none (sits on chat background)
- Text: `var(--text-primary)`, 15px weight 400, line-height 1.6
- Avatar: 28px circle with Ouroboros icon, left of message
- Name: "Ouroboros", 14px weight 600, above message body
- Markdown: full rendering — headings, lists, code blocks, tables, links
- Max width: 80% of chat area
- Alignment: left

### Tool Call Chips

**Collapsed (default)**
- Background: `var(--bg-tool-chip)`
- Text: `var(--text-secondary)`, 13px weight 500
- Padding: 6px 12px
- Radius: 6px
- Border: `1px solid var(--border-light)`
- Icon: 14px, left of label (file icon, terminal icon, pencil icon, etc.)
- Status: spinner (running), checkmark (done), x (failed)
- Cursor: pointer

**Expanded (on click)**
- Background: `var(--bg-tool-expanded)`
- Radius: 10px
- Border: `1px solid var(--border-light)`
- Padding: 12px
- Header: chip label + status + duration ("1.2s")
- Content: input summary, then syntax-highlighted output in monospace
- Max height: 300px with scroll
- Close: click header again to collapse

### RSI Notification Card

- Background: `var(--bg-rsi-card)` (amber-tinted gradient)
- Text: `var(--text-primary)`, 14px weight 400
- Padding: 12px 16px
- Radius: 10px
- Border: `1px solid var(--accent-amber-bg)`
- Left accent: 3px solid `var(--accent-amber)` left border
- Dismissable: small x button top-right
- Content: single line of plain language ("Learned a new skill from this task")

### Approval Toast

- Background: `var(--bg-chat)` (white/dark)
- Border: `1px solid var(--border-light)`
- Radius: 12px
- Shadow: `var(--shadow-lg)`
- Padding: 16px
- Position: fixed top-right, 16px from edges
- Title: 14px weight 600
- Description: 13px weight 400, `var(--text-secondary)`
- Risk badge: pill with color (red for high, orange for medium)
- Buttons: Approve (amber primary) + Deny (danger) side by side
- Animation: slide in from right, fade out on dismiss

### Command Palette

- Background: `var(--bg-palette)`
- Border: `1px solid var(--border-light)`
- Radius: 12px
- Shadow: `var(--shadow-xl)`
- Width: 560px, centered horizontally, 20% from top
- Search input: 16px weight 400, full width, no border, large padding (16px)
- Divider: `1px solid var(--border-light)` below search
- Result items: 14px weight 400, 12px padding, hover background `var(--bg-hover)`
- Group headers: 11px weight 600, uppercase, `var(--text-tertiary)`, 8px padding
- Shortcut hints: 11px monospace, `var(--text-tertiary)`, right-aligned
- Selected item: `var(--bg-hover)` background
- Max height: 400px with scroll

### Session Sidebar

- Background: `var(--bg-sidebar)`
- Width: 250px (collapsible to 0)
- Border-right: `1px solid var(--border-light)`
- Session items: 13px weight 400, 10px 12px padding
- Active session: `var(--bg-sidebar-active)` background, 6px radius
- Date group headers: 11px weight 600, uppercase, `var(--text-tertiary)`
- New conversation button: icon button at top

### RSI Drawer

- Background: `var(--bg-drawer)`
- Width: 350px
- Border-left: `1px solid var(--border-light)`
- Shadow: `var(--shadow-lg)` on the left edge
- Animation: slide in from right, 200ms ease
- Header: 18px weight 600 + close icon button
- Stats: 4-column grid of number (24px weight 700) + label (11px weight 400, `var(--text-secondary)`)
- Activity feed: list of 13px entries, each with timestamp (12px, `var(--text-tertiary)`)
- Skill list: 14px weight 500 name + 12px description, status badge right-aligned

### Badges

| Type | Background | Text | Border | Use |
|------|-----------|------|--------|-----|
| Core | `rgba(37,99,235,0.1)` | `#2563EB` | none | Core skills |
| Generated | `rgba(217,119,6,0.1)` | `#D97706` | none | Self-generated skills |
| Staging | `rgba(107,107,107,0.1)` | `#6B6B6B` | none | Skills under test |
| Success | `rgba(22,163,74,0.1)` | `#16A34A` | none | Tests passed |
| Error | `rgba(220,38,38,0.1)` | `#DC2626` | none | Tests failed |

All badges: 11px weight 600, 4px 8px padding, 4px radius.

### Input Bar

- Background: `var(--bg-input)`
- Border-top: `1px solid var(--border-light)`
- Padding: 12px 16px
- Textarea: 15px weight 400, no border, transparent background, auto-resize 1-5 lines
- Attachment button: icon button, left of textarea
- Workspace indicator: 12px weight 400, folder icon + path, `var(--text-secondary)`, clickable
- Model badge: 11px weight 500, pill shape, `var(--text-tertiary)`, clickable
- Send button: amber primary, right of textarea

## 5. Layout Principles

### Spacing System
- Base unit: 4px
- Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48px
- Primary rhythm: 8px for tight spacing, 16px for standard, 24px for section gaps, 32-48px for major sections

### App Dimensions
- Minimum window: 800 x 600px
- Default window: 1200 x 800px
- Sidebar: 250px (collapsible)
- Drawer: 350px
- Command palette: 560px wide
- Chat messages: max 80% of chat area width
- Input bar: full width, fixed bottom

### Whitespace Philosophy
- **Conversation breathing room**: Messages have 16px vertical gap between them. Agent messages have internal paragraph spacing. This is a chat app, not a log viewer.
- **Sidebar economy**: Session items are compact (10px 12px padding) because the sidebar is narrow, but the main chat area is generous.
- **Progressive density**: Collapsed tool chips are compact (6px 12px). Expanded tool output has 12px padding and syntax highlighting. The user controls the density.

### Border Radius Scale
- Micro (4px): Badges, inline code, small tags
- Standard (6px): Buttons, inputs, tool chips, icon buttons
- Comfortable (10px): Cards, expanded tool output, settings panels
- Large (12px): Command palette, approval toasts, drawer
- Message (16px): Chat message bubbles
- Extra Large (20px): Onboarding cards
- Full (50%): Avatars, status indicators, icon-only buttons

## 6. Depth & Elevation

| Level | Shadow | Use |
|-------|--------|-----|
| Flat | None | Sidebar, chat messages, inline content |
| Subtle | `0 1px 2px rgba(0,0,0,0.05)` | Tool chips, badges, input bar border |
| Medium | `0 4px 12px rgba(0,0,0,0.08)` | Dropdowns, tooltips, hover cards |
| High | `0 12px 40px rgba(0,0,0,0.12)` | RSI drawer, approval toasts |
| Maximum | `0 20px 60px rgba(0,0,0,0.16)` | Command palette, modal overlays |

**Dark theme shadows** use higher opacity: 0.2, 0.3, 0.4, and include no additional border tricks — the elevated surface background colors (`#222226`, `#2C2C30`) already create visual separation.

**Elevation strategy**: The chat area is flat (Level 0). Overlays stack above it: drawer (High), command palette (Maximum), approval toast (High). This creates a clear z-axis: conversation < panels < modals.

## 7. Do's and Don'ts

### Do
- Use warm neutrals for backgrounds — `#FAFAF8`, `#F4F0EB`, `#F2F1EE` — not cold grays or pure whites
- Keep amber (`#D97706`) reserved for interactive elements and RSI indicators only
- Use system fonts first (`-apple-system, BlinkMacSystemFont`) for native feel
- Set body text at 15px minimum — this is a reading interface, not a code editor
- Provide generous whitespace between chat messages (16px+ gaps)
- Show tool calls as compact chips by default — expand on click
- Keep RSI activity ambient: subtle glow on the serpent icon, brief inline cards
- Use plain language for RSI events: "Learned a new skill" not "Crystallization outcome: promoted"
- Support both light and dark themes with warm tones in both
- Make the command palette the primary navigation — it replaces menus and nav bars

### Don't
- Don't use monospace for anything except code blocks and tool output
- Don't use cold blue-grays — the palette is warm (cream, amber, warm dark)
- Don't show RSI pipeline stages or technical details inline — those belong in the drawer
- Don't use celebration animations for skill crystallization — keep it ambient
- Don't add navigation bars, tab strips, or activity bars — the command palette handles navigation
- Don't use information-dense layouts — this is not an IDE, it's a conversation
- Don't use pure black (`#000000`) in dark mode — warm dark (`#1A1A1E`) prevents harshness
- Don't use pure white (`#FFFFFF`) as a background in light mode (except for the chat area) — off-white (`#FAFAF8`) is warmer
- Don't apply amber to large surfaces — it's an accent, not a theme color
- Don't show technical jargon in the default view — "Read file" not "FileReadTool: src/config.ts"

## 8. Responsive Behavior

### Window Sizes
| Breakpoint | Width | Behavior |
|------------|-------|----------|
| Compact | 800-1000px | Sidebar collapsed by default, drawer overlays chat |
| Standard | 1000-1400px | Sidebar visible, drawer overlays chat |
| Wide | >1400px | Sidebar visible, drawer can push chat (optional) |

### Sidebar Collapsing
- Below 1000px: sidebar auto-collapses, togglable via hamburger or Cmd+B
- Above 1000px: sidebar visible by default
- Transition: 200ms ease slide

### Chat Area
- Messages max-width: 80% of available width, capped at 720px
- On narrow windows (<900px), max-width increases to 90%
- Input bar: always full width, always fixed bottom

### Command Palette
- Fixed width: 560px centered
- On windows narrower than 600px: full width with 16px horizontal margin

### Drawer
- Always overlays (never pushes content)
- 350px width or 90% of window width, whichever is smaller

## 9. Agent Prompt Guide

### Quick Color Reference (Light)
- Page background: `#FAFAF8`
- Chat background: `#FFFFFF`
- User message: `#F4F0EB`
- Primary text: `#1A1A1A`
- Secondary text: `#6B6B6B`
- Amber accent: `#D97706`
- Amber hover: `#F59E0B`
- Default border: `#E8E7E3`
- Success: `#16A34A`
- Error: `#DC2626`

### Quick Color Reference (Dark)
- Page background: `#1A1A1E`
- Chat background: `#1E1E22`
- User message: `#2A2720`
- Primary text: `#ECECEC`
- Secondary text: `#9B9B9B`
- Amber accent: `#D97706` (unchanged)
- Default border: `#333337`

### Example Component Prompts
- "Create a chat message from the agent: no background, left-aligned, 28px Ouroboros avatar circle, 'Ouroboros' name at 14px weight 600, body at 15px weight 400 line-height 1.6, `#1A1A1A` text on `#FFFFFF` chat background. Max width 80%."
- "Create a tool call chip: `#F6F5F2` background, `1px solid #E8E7E3` border, 6px radius, 6px 12px padding. Terminal icon + 'Ran command' at 13px weight 500 `#6B6B6B`. Green checkmark right-aligned. Click expands to show monospace output."
- "Create the RSI status indicator: 24px serpent SVG icon in `#9B9B9B`. When active, pulse with `rgba(245,158,11,0.4)` glow animation, 2s infinite. On click, slide in a 350px drawer from the right."
- "Create a command palette: `#FFFFFF` background, `1px solid #E8E7E3` border, 12px radius, `0 20px 60px rgba(0,0,0,0.16)` shadow. 560px wide, centered. Search input 16px, full width. Results in groups with 11px uppercase headers."
- "Create an approval toast: `#FFFFFF` background, 12px radius, `0 12px 40px rgba(0,0,0,0.12)` shadow. Fixed top-right. Title 14px weight 600, description 13px `#6B6B6B`. Amber 'Approve' button + red 'Deny' button."

### Iteration Guide
1. Always use the system font stack — never load custom web fonts in the Electron renderer
2. Amber (`#D97706`) is the ONLY chromatic accent in the shell — everything else is neutral gray
3. Status colors (green, blue, purple, red, orange) appear only in badges, icons, and inline indicators — never as surface colors
4. Chat messages at 15px body, 16px gap — optimize for comfortable reading, not density
5. Tool chips are compact by default — detail is progressive, revealed on click
6. RSI activity is ambient — serpent icon glow + brief inline cards, nothing modal or interruptive
7. Command palette is the front door to every feature — if a user can't find it via Cmd+K, it doesn't exist in the UI
8. Both themes must feel warm — light uses cream/off-white, dark uses warm gray with amber tint, never cold
