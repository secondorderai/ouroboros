# Desktop Onboarding And Chat

## Mission

Verify that a new user can configure AI access, choose Simple mode, send a chat
message, see progress, and return to an idle input state.

## Priority / Tags

p0, smoke, desktop, onboarding, chat

## Initial State

- Fresh Electron user data directory.
- Mock CLI scenario uses default successful config and agent responses.
- App is launched in test mode through Electron CDP.

## Intent Steps

1. Complete AI setup with a test Anthropic API key.
2. Choose Simple mode.
3. Send `Summarize this workspace`.
4. Observe the user message in the transcript.
5. Wait for the assistant response to complete.
6. Confirm the message input is available for another turn.

## Expected Outcomes

- The setup flow advances without errors.
- The main chat input is visible after onboarding.
- The sent user message is visible.
- The assistant response appears.
- The send control returns to its idle enabled state.
- No user-facing crash, blank screen, or uncaught renderer error is present.

## Evidence Required

- Annotated screenshot at initial state.
- Annotated screenshot after onboarding.
- Annotated screenshot after final response.
- Console and page error output.
