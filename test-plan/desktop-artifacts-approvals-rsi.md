# Desktop Artifacts Approvals And RSI

## Mission

Verify that important secondary desktop surfaces are reachable and usable:
artifacts, approvals, and the self-improvement history drawer.

## Priority / Tags

p1, desktop, surfaces, artifacts, approvals, rsi

## Initial State

- App is launched in test mode through Electron CDP.
- Mock CLI scenario may include skills, approvals, RSI history, and artifacts.
- If the current scenario has no data for a surface, record that as
  `INCONCLUSIVE` for that check rather than inventing state.

## Intent Steps

1. Complete onboarding into Simple mode if onboarding is shown.
2. Open the command palette or visible navigation controls.
3. Find and inspect the artifacts surface.
4. Find and inspect the approvals queue.
5. Find and inspect the self-improvement or RSI history surface.
6. For each available surface, confirm it can be opened and closed without
   breaking the chat layout.

## Expected Outcomes

- Available secondary surfaces are discoverable from visible controls.
- Opening a surface does not blank the app or trap focus permanently.
- Empty states are understandable when no mock data exists.
- Closing or navigating away returns to the main desktop shell.
- No uncaught renderer error is present.

## Evidence Required

- Screenshot for each opened surface.
- Screenshot after returning to the main shell.
- Console and page error output.
