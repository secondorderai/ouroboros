# Desktop Cancel And Recovery

## Mission

Verify that a user can stop an in-progress agent run, keep partial output, and
recover to send another message.

## Priority / Tags

p0, smoke, desktop, chat, cancel

## Initial State

- Fresh Electron user data directory.
- Mock CLI scenario supports chat runs.
- App is launched in test mode through Electron CDP.

## Intent Steps

1. Complete onboarding into Simple mode if onboarding is shown.
2. Send `Run a long task`.
3. Wait until the UI indicates an agent run is in progress.
4. Stop the run.
5. Confirm partial conversation content remains visible.
6. Send `Continue with a short answer`.
7. Confirm the app accepts the new message.

## Expected Outcomes

- A stop control is available while the run is active.
- Stopping does not clear the transcript.
- The input recovers after stopping.
- A follow-up message can be sent.
- No duplicate stuck loading states remain.

## Evidence Required

- Screenshot during active run.
- Screenshot after stop.
- Screenshot after follow-up send.
- Console and page error output.
