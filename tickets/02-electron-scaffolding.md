# Electron Project Scaffolding

**Phase:** 3.1 — Scaffolding
**Type:** Frontend / Infrastructure
**Priority:** P0
**Depends on:** None
**Repo:** `ouroboros-desktop` (new repo)

## Context

Initialize the new `ouroboros-desktop` repository with an Electron + React + Vite project structure. This is the foundation for all subsequent desktop app tickets. The app shell should render correctly on macOS and Windows with the design system from `DESIGN.md`.

## Requirements

### Repository Setup

- Initialize a new git repo `ouroboros-desktop`
- TypeScript throughout (strict mode)
- Package manager: npm or pnpm (not Bun — Electron ecosystem is npm-native)
- License: match the CLI repo

### Project Structure

```
ouroboros-desktop/
├── src/
│   ├── main/                  # Electron main process
│   │   ├── index.ts           # App entry point, window creation
│   │   ├── preload.ts         # IPC bridge (whitelisted API)
│   │   └── window.ts          # Window management, bounds persistence
│   ├── renderer/              # React app
│   │   ├── index.html         # Vite entry HTML
│   │   ├── main.tsx           # React root
│   │   ├── App.tsx            # App shell layout
│   │   ├── components/        # Shared UI components
│   │   ├── views/             # Page-level views (chat, settings, etc.)
│   │   ├── hooks/             # React hooks
│   │   ├── stores/            # State management
│   │   ├── styles/            # Global CSS, theme variables
│   │   └── lib/               # Utilities, protocol types
│   └── shared/                # Types shared between main and renderer
│       └── protocol.ts        # JSON-RPC message type definitions
├── resources/                 # App icons, bundled CLI binary (later)
├── electron-builder.yml       # Build configuration
├── vite.config.ts             # Vite config for renderer
├── tsconfig.json
├── package.json
├── DESIGN.md                  # Copied from CLI repo
└── README.md
```

### App Shell

Implement the basic app window with:

- **Custom title bar** with drag region
  - macOS: Traffic light buttons positioned in the title bar area
  - Windows: Custom minimize/maximize/close buttons
- **Sidebar placeholder** (250px, collapsible) — just a colored panel for now
- **Main content area** — centered "Ouroboros" text placeholder
- **Input bar placeholder** — fixed bottom bar with a text input (non-functional)

### Theme System

Implement the dual-theme system from `DESIGN.md`:

- CSS custom properties for all design tokens (colors, spacing, shadows, radii)
- Light theme (default) and dark theme
- System preference detection (`prefers-color-scheme`)
- Theme toggle button (sun/moon icon) in the title bar
- Theme persisted in electron-store across restarts

### Electron Configuration

- **Context isolation:** enabled
- **Node integration in renderer:** disabled
- **Preload script:** with a minimal whitelisted API (just `getTheme`/`setTheme` for now)
- **Single instance lock:** prevent multiple app windows
- **Window bounds persistence:** save/restore window position and size

### Build Configuration

- electron-builder config targeting macOS and Windows
- Development mode: `npm run dev` starts both Vite dev server and Electron
- Production build: `npm run build` produces unsigned local builds for testing
- Code signing is deferred to ticket 13

## Scope Boundaries

- No CLI spawning or JSON-RPC communication (that's ticket 03)
- No chat UI, command palette, or any functional views (those are tickets 04-12)
- No code signing or distribution packaging (that's ticket 13)
- The app is an empty shell with correct styling — a canvas for future tickets

## Acceptance Criteria

- [ ] `ouroboros-desktop` repo is initialized with the project structure above
- [ ] `npm run dev` launches an Electron window with the Vite dev server
- [ ] App window renders with custom title bar (platform-appropriate buttons)
- [ ] Sidebar panel is visible and collapsible (toggle via a temporary button)
- [ ] Light and dark themes switch correctly via the title bar toggle
- [ ] Theme follows system preference on first launch
- [ ] Theme choice persists across app restarts
- [ ] Single instance lock prevents opening two windows
- [ ] Window position and size are restored on restart
- [ ] `npm run build` produces a runnable local build (unsigned)
- [ ] TypeScript compiles with zero errors in strict mode

## Feature Tests

- **Test: App launches without errors**
  - **Setup:** Run `npm run dev`.
  - **Action:** Electron window opens.
  - **Expected:** Window visible with title bar, sidebar placeholder, and main content area. No console errors.

- **Test: Theme toggle**
  - **Setup:** App running in light theme.
  - **Action:** Click the theme toggle button.
  - **Expected:** UI switches to dark theme. Background colors, text colors, and borders all update per DESIGN.md tokens.

- **Test: System theme detection**
  - **Setup:** OS set to dark mode. Launch app for the first time (no persisted preference).
  - **Expected:** App starts in dark theme.

- **Test: Window bounds persistence**
  - **Setup:** Move and resize the window. Quit and relaunch.
  - **Expected:** Window appears at the same position and size.

- **Test: Single instance**
  - **Setup:** App is already running.
  - **Action:** Try to launch a second instance.
  - **Expected:** Second instance does not open. First instance is focused/restored.

## Notes

- Copy `DESIGN.md` from the CLI repo into the desktop repo root so the design tokens are available locally.
- For the custom title bar, use Electron's `titleBarStyle: 'hiddenInset'` on macOS and `titleBarStyle: 'hidden'` with `titleBarOverlay` on Windows.
- Use `electron-store` for simple key-value persistence (theme, window bounds, onboarding flag).
- The Vite config needs `electron-vite` or a similar plugin to handle the main/renderer/preload build pipeline.
