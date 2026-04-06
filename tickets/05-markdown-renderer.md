# Markdown Renderer & Code Highlighting

**Phase:** 3.2 — Chat Core
**Type:** Frontend
**Priority:** P0
**Depends on:** 04-chat-messages
**Repo:** `packages/desktop/`

## Context

Agent responses are markdown-formatted. The renderer must support full GitHub Flavored Markdown (GFM) with syntax-highlighted code blocks. This component replaces the raw text display used during streaming once `agent/turnComplete` fires.

## Requirements

### Markdown Rendering

Use a markdown-to-React library (e.g., `react-markdown` with `remark-gfm` plugin) that supports:

- **Headings** (H1-H6) — styled per DESIGN.md typography scale
- **Paragraphs** — 15px body text, 1.6 line-height
- **Bold, italic, strikethrough**
- **Lists** (ordered and unordered, nested)
- **Tables** — bordered, alternating row backgrounds
- **Inline code** — monospace with subtle background (`var(--bg-tool-chip)`)
- **Links** — amber accent color, open in external browser (not in-app)
- **Blockquotes** — left border accent, muted background
- **Horizontal rules**
- **Images** — render inline with max-width constraint (if agent returns image URLs)

### Code Blocks

- Syntax highlighting via a library (e.g., `shiki`, `highlight.js`, or `prism-react-renderer`)
- Language detection from the fenced code block label (```typescript, ```python, etc.)
- Dark and light theme variants matching DESIGN.md
- **Copy button** — appears on hover in the top-right corner of the code block. Copies the code content to clipboard.
- Monospace font: `var(--font-mono)` from DESIGN.md
- Horizontal scroll for long lines (no wrapping)
- Line numbers: off by default (not an IDE)

### Styling Integration

All markdown elements must respect the current theme (light/dark) using DESIGN.md CSS variables. No hardcoded colors in the markdown renderer — everything references `var(--text-primary)`, `var(--border-light)`, etc.

## Scope Boundaries

- This ticket renders static markdown only — streaming text uses raw pre-wrap (ticket 04 handles that)
- No LaTeX/math rendering
- No Mermaid diagram rendering
- No custom component embeds (just standard GFM)

## Acceptance Criteria

- [ ] Full GFM renders correctly: headings, lists, tables, code blocks, inline code, links, bold/italic, blockquotes
- [ ] Code blocks have syntax highlighting for at least: TypeScript, JavaScript, Python, Bash, JSON, YAML, HTML, CSS
- [ ] Code blocks have a copy-to-clipboard button on hover
- [ ] All elements respect the current theme (light/dark) via CSS variables
- [ ] Links open in the system's default external browser, not in-app
- [ ] Long code lines scroll horizontally without breaking layout
- [ ] No layout shift when switching from streaming text to markdown-rendered text

## Feature Tests

- **Test: Heading hierarchy renders**
  - **Setup:** Agent message contains `# H1\n## H2\n### H3`.
  - **Expected:** Three distinct heading sizes per DESIGN.md typography scale.

- **Test: Code block with highlighting**
  - **Setup:** Agent message contains a fenced TypeScript code block.
  - **Expected:** Code is syntax-highlighted with TypeScript keywords colored. Monospace font. Copy button on hover.

- **Test: Copy code button**
  - **Setup:** Hover over a code block.
  - **Action:** Click the copy button.
  - **Expected:** Code content is in the clipboard. Button shows brief "Copied" feedback.

- **Test: Table rendering**
  - **Setup:** Agent message contains a GFM table.
  - **Expected:** Table renders with borders, header row styled differently.

- **Test: Theme consistency**
  - **Setup:** Switch between light and dark theme.
  - **Expected:** All markdown elements update colors. No hardcoded light-mode colors in dark mode.

- **Test: External link handling**
  - **Setup:** Agent message contains `[link](https://example.com)`.
  - **Action:** Click the link.
  - **Expected:** Opens in the system browser, not in the Electron window.

## Notes

- `react-markdown` + `remark-gfm` + `rehype-highlight` (or `shiki`) is the most common stack for this. Shiki produces better highlighting but is heavier — `highlight.js` via `rehype-highlight` is lighter and sufficient.
- For the "no layout shift" criterion: the streaming raw text and the final markdown-rendered text should occupy approximately the same height. Use the same font and line-height settings for both.
- Code block themes should be customized to match DESIGN.md's warm palette, not the default highlight.js themes.
