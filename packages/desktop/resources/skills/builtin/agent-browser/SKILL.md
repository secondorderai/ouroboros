---
name: agent-browser
description: Use this skill when the user wants Ouroboros to browse or automate websites in a real Chrome-compatible browser. Prefer it for navigating pages, taking browser snapshots, clicking or filling visible controls, scraping page state, testing web flows, and using CDP auto-connect without asking the user to install npm packages.
metadata:
  short-description: Automate websites with bundled Agent Browser
---

# Agent Browser

Use the `browser-automation` tool for browser automation. Do not ask the user to install npm, run `npm install`, run `npx`, install Homebrew, or install Agent Browser manually.

## Default Workflow

1. Start with `browser-automation` action `snapshot`. In Ouroboros Desktop, this prefers the managed Automation Browser when it is running, then falls back to CDP auto-connect.
2. If a page is not open yet, use action `open` with the target URL.
3. Use the refs from snapshots, such as `@e1` or `@e2`, for `click` and `fill`.
4. Re-run `snapshot` after every navigation, click, form submission, tab switch, or other page change because refs can become stale.
5. Prefer structured observations from `snapshot` over guessing selectors.

## Actions

- `help`: Inspect available Agent Browser command help.
- `doctor`: Run a quick offline diagnostic.
- `connect`: Connect to a CDP port when one is known.
- `open`: Navigate to a URL.
- `snapshot`: Read the current page and interactive refs.
- `click`: Click a snapshot ref.
- `fill`: Fill a snapshot ref with text.
- `press`: Send a key or key chord.
- `wait`: Wait for page state.
- `tab`: Inspect or manage tabs.
- `close`: Close the browser session.

## Managed Browser and CDP

In Ouroboros Desktop, prefer the managed Automation Browser. Do not ask the user to launch Chrome from a terminal.

The tool uses the managed CDP endpoint when Desktop provides one. If no managed browser is running, it falls back to Agent Browser CDP auto-connect. Use explicit `cdp` only when the user provides a port or WebSocket URL, or when a diagnostic shows a known port such as `9222` or `9229`.

## Failure Handling

If the tool reports that Chrome or CDP auto-connect is unavailable, explain the user-facing steps plainly:

1. Open Settings -> Automation Browser in Ouroboros.
2. Click Launch Automation Browser.
3. Choose Separate automation profile for the safest default, or My Chrome profile if existing logins are needed.
4. If Chrome is not installed, install Google Chrome from `https://www.google.com/chrome/`, then retry.

Keep the explanation focused on the managed Automation Browser. Do not tell ordinary users to install Agent Browser, npm, npx, Homebrew, Cargo, Node.js, or to relaunch Chrome with terminal flags unless the user explicitly asks for manual debugging.
