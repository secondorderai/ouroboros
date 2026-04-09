# Design System: Ouroboros

## 1. Visual Theme & Atmosphere

Ouroboros is a chat-first autonomous AI agent desktop app. The visual language is calm, precise, and readable — designed for users who want a conversational interface that still feels like a focused tool. The aesthetic draws from Codex-style restraint, Linear's precision, and Arc's command-palette-driven navigation.

The light theme uses cool neutrals and soft off-whites. The dark theme uses charcoal and blue-black surfaces rather than warm gray. Slate blue is the signature accent color: present on interactive elements, active states, links, and the primary send action, but never spread across large surfaces.

Typography uses the system font stack for speed and native feel, with Inter as the preferred web fallback. Text is set in clean sans-serif at comfortable sizes optimized for reading conversations. Monospace is reserved strictly for code blocks and tool output. The overall density is low: generous padding, breathing room between messages, and progressive disclosure that hides complexity until requested.

**Key Characteristics:**
- Neutral-first palette: soft off-white backgrounds (`#F5F6F7`), cool gray message bubbles (`#EFF1F3`), blue-black dark mode (`#0B0D10`)
- Slate blue accent: `#3E5F8A` (primary), `#334F74` (hover), `#89A7D1` (dark-mode highlight) — the only branded accent in the shell
- System font stack with Inter fallback — native feel on every platform
- Chat-first layout: conversation is always the primary surface
- Progressive disclosure: minimal by default, details on demand (command palette, drawers, expandable chips)
- Low information density: generous whitespace, comfortable font sizes, relaxed line heights
- Dual theme: light (default) and dark, both cool and restrained

## 2. Color Palette & Roles

### Light Theme

#### Background Surfaces
- **Primary** (`#F5F6F7`): Main app background. Soft cool white.
- **Secondary** (`#ECEEF0`): Sidebar background, section dividers. One step darker.
- **Tertiary** (`#DCE1E7`): Borders, divider lines, subtle separators.
- **Chat** (`#FFFFFF`): Chat area background. Pure white for maximum readability of conversation.
- **Input** (`#FFFFFF`): Input field backgrounds.
- **User Message** (`#EFF1F3`): User message bubble background. Subtly distinct without introducing warmth.
- **Tool Chip** (`#F1F3F6`): Collapsed tool call chip background.
- **Tool Expanded** (`#F8FAFC`): Expanded tool call detail background.
- **RSI Card** (`linear-gradient(135deg, #F4F7FB 0%, #EDF2F8 100%)`): RSI notification card. Light slate-blue tint without becoming decorative.
- **Sidebar** (`#ECEEF0`): Session sidebar background.
- **Sidebar Active** (`rgba(62,95,138,0.10)`): Active/selected session item.
- **Hover** (`rgba(14,17,22,0.05)`): Universal hover state overlay.
- **Overlay** (`rgba(0,0,0,0.3)`): Modal/drawer backdrop.

#### Text
- **Primary** (`#0E1116`): Headings, agent message body, user input. Near-black for strong contrast.
- **Secondary** (`#5E6673`): Body text, descriptions, session metadata. Mid-gray with a cool cast.
- **Tertiary** (`#8C95A3`): Timestamps, placeholders, de-emphasized content.
- **Inverse** (`#FFFFFF`): Text on primary action buttons or dark surfaces.

#### Border
- **Light** (`#DCE1E7`): Default borders — sidebar edges, input outlines, card dividers.
- **Medium** (`#C9D1DB`): Stronger borders for emphasis — focused inputs, active sections.

#### Accent & Status
- **Slate Blue** (`#3E5F8A`): Primary interactive accent. Send button, active indicators, focus rings, links.
- **Slate Blue Hover** (`#334F74`): Hover state for primary accent elements.
- **Slate Blue Background** (`rgba(62,95,138,0.10)`): Subtle accent tint for active chips and RSI-related backgrounds.
- **Green** (`#16A34A`): Success states. Tool call completed, tests passed, skill promoted.
- **Blue** (`#2563EB`): Informational. Links in agent messages, core skill badges.
- **Purple** (`#7C3AED`): Generated skill badges, evolution events.
- **Red** (`#DC2626`): Error states, destructive actions, denied approvals.
- **Orange** (`#EA580C`): Warning states, staging skill badges.

### Dark Theme

#### Background Surfaces
- **Primary** (`#0B0D10`): Main app background. Blue-black, not pure black.
- **Secondary** (`#12161B`): Elevated panels, drawer background.
- **Tertiary** (`#171C22`): Higher elevation — dropdown menus, popovers.
- **Chat** (`#0F1317`): Chat area. Slightly lighter than primary for subtle depth.
- **Input** (`#11161A`): Input field backgrounds.
- **User Message** (`#171C22`): User bubble. Distinct from the chat plane without warmth.
- **Tool Chip** (`#151A20`): Collapsed tool chip.
- **Tool Expanded** (`#12161B`): Expanded tool detail.
- **RSI Card** (`linear-gradient(135deg, rgba(62,95,138,0.18) 0%, #10151B 100%)`): RSI card with a restrained slate-blue tint.
- **Sidebar** (`#12161B`): Matches secondary for stronger structure.
- **Sidebar Active** (`rgba(137,167,209,0.16)`): Selected session.
- **Hover** (`rgba(255,255,255,0.06)`): Universal hover overlay.
- **Overlay** (`rgba(0,0,0,0.6)`): Darker overlay for modals on dark backgrounds.

#### Text (Dark)
- **Primary** (`#EEF2F6`): Headings and body. Not pure white — prevents eye strain.
- **Secondary** (`#97A1AD`): Descriptions, metadata.
- **Tertiary** (`#64707C`): Placeholders, timestamps.
- **Inverse** (`#0E1116`): Text on light accent surfaces.

#### Border (Dark)
- **Light** (`#232A33`): Default borders.
- **Medium** (`#2F3944`): Emphasized borders.

#### Accent (Dark) — same base hue, brighter highlights
- **Slate Blue Background** (`rgba(137,167,209,0.12)`): Slightly more opaque for visibility on dark.
- **Slate Blue Highlight** (`#89A7D1`): Links, hover text, and selected inline emphasis.
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

**Primary (Slate Blue)**
- Background: `#3E5F8A`
- Text: `#FFFFFF`, 14px weight 500
- Padding: 8px 16px
- Radius: 6px
- Hover: `#334F74`
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

- Background: `var(--bg-rsi-card)` (slate-blue tinted gradient)
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
- Buttons: Approve (slate blue primary) + Deny (danger) side by side
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
| Generated | `rgba(62,95,138,0.1)` | `#3E5F8A` | none | Self-generated skills |
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
- Send button: slate blue primary, right of textarea

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

**Dark theme shadows** use higher opacity: 0.2, 0.3, 0.4, and include no additional border tricks — the elevated surface background colors (`#12161B`, `#171C22`) already create visual separation.

**Elevation strategy**: The chat area is flat (Level 0). Overlays stack above it: drawer (High), command palette (Maximum), approval toast (High). This creates a clear z-axis: conversation < panels < modals.

## 7. Do's and Don'ts

### Do
- Use neutral-first backgrounds — `#F5F6F7`, `#ECEEF0`, `#EFF1F3` — and let contrast, not color, carry structure
- Keep slate blue (`#3E5F8A`) reserved for interactive elements, focus, active states, and links
- Use system fonts first (`-apple-system, BlinkMacSystemFont`) for native feel
- Set body text at 15px minimum — this is a reading interface, not a code editor
- Provide generous whitespace between chat messages (16px+ gaps)
- Show tool calls as compact chips by default — expand on click
- Keep RSI activity ambient: subtle glow on the serpent icon, brief inline cards
- Use plain language for RSI events: "Learned a new skill" not "Crystallization outcome: promoted"
- Support both light and dark themes with cool, restrained neutrals in both
- Make the command palette the primary navigation — it replaces menus and nav bars

### Don't
- Don't use monospace for anything except code blocks and tool output
- Don't flood the interface with accent color — the shell should still read clearly in grayscale
- Don't show RSI pipeline stages or technical details inline — those belong in the drawer
- Don't use celebration animations for skill crystallization — keep it ambient
- Don't add navigation bars, tab strips, or activity bars — the command palette handles navigation
- Don't use information-dense layouts — this is not an IDE, it's a conversation
- Don't use pure black (`#000000`) in dark mode — blue-black (`#0B0D10`) keeps depth without harshness
- Don't over-warm the light theme with cream or beige surfaces
- Don't apply slate blue to large surfaces — it's an accent, not a theme color
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
- Page background: `#F5F6F7`
- Chat background: `#FFFFFF`
- User message: `#EFF1F3`
- Primary text: `#0E1116`
- Secondary text: `#5E6673`
- Slate blue accent: `#3E5F8A`
- Slate blue hover: `#334F74`
- Default border: `#DCE1E7`
- Success: `#16A34A`
- Error: `#DC2626`

### Quick Color Reference (Dark)
- Page background: `#0B0D10`
- Chat background: `#0F1317`
- User message: `#171C22`
- Primary text: `#EEF2F6`
- Secondary text: `#97A1AD`
- Slate blue accent: `#3E5F8A`
- Slate blue highlight: `#89A7D1`
- Default border: `#232A33`

### Example Component Prompts
- "Create a chat message from the agent: no background, left-aligned, 28px Ouroboros avatar circle, 'Ouroboros' name at 14px weight 600, body at 15px weight 400 line-height 1.6, `#0E1116` text on `#FFFFFF` chat background. Max width 80%."
- "Create a tool call chip: `#F1F3F6` background, `1px solid #DCE1E7` border, 6px radius, 6px 12px padding. Terminal icon + 'Ran command' at 13px weight 500 `#5E6673`. Green checkmark right-aligned. Click expands to show monospace output."
- "Create the RSI status indicator: 24px serpent SVG icon in `#8C95A3`. When active, use a restrained `rgba(62,95,138,0.18)` accent surface or drawer highlight rather than a warm glow."
- "Create a command palette: `#FFFFFF` background, `1px solid #DCE1E7` border, 12px radius, `0 20px 60px rgba(0,0,0,0.16)` shadow. 560px wide, centered. Search input 16px, full width. Results in groups with 11px uppercase headers."
- "Create an approval toast: `#FFFFFF` background, 12px radius, `0 12px 40px rgba(0,0,0,0.12)` shadow. Fixed top-right. Title 14px weight 600, description 13px `#5E6673`. Slate blue 'Approve' button + red 'Deny' button."

### Iteration Guide
1. Always use the system font stack — never load custom web fonts in the Electron renderer
2. Slate blue (`#3E5F8A`) is the ONLY branded accent in the shell — everything else is neutral gray
3. Status colors (green, blue, purple, red, orange) appear only in badges, icons, and inline indicators — never as surface colors
4. Chat messages at 15px body, 16px gap — optimize for comfortable reading, not density
5. Tool chips are compact by default — detail is progressive, revealed on click
6. RSI activity is ambient — serpent icon glow + brief inline cards, nothing modal or interruptive
7. Command palette is the front door to every feature — if a user can't find it via Cmd+K, it doesn't exist in the UI
8. Both themes must feel cool and restrained — light uses soft neutrals, dark uses blue-black surfaces, never warm beige or amber
