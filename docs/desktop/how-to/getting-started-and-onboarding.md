# Get Started And Complete Onboarding

## What This Is For

Onboarding prepares the installed macOS desktop app for its first conversation.
It connects an AI provider, stores the selected model settings, and creates the
first chat in either `Simple` or `Workspace` mode.

## When To Use It

Use onboarding on first launch, after clearing app storage, or when setting up
Ouroboros on a new Mac.

## Steps

1. Download the published macOS release file.
2. Open the downloaded release file and move `Ouroboros.app` to `Applications`
   if macOS asks you to.
3. Open `Ouroboros.app`.
4. If macOS blocks the first launch, right-click `Ouroboros.app`, choose `Open`,
   then confirm you want to open it.
5. On the first onboarding screen, choose a provider.
6. For API-key providers, enter the API key. For `OpenAI-compatible`, also enter
   the base URL.
7. Choose or type the model name.
8. Continue to the mode screen.
9. Choose `Simple` for an isolated chat or `Workspace` for a chat tied to a
   folder.
10. If you choose `Workspace`, click the folder picker and select the workspace
   folder.
11. Finish onboarding. The app creates the first session and opens the chat
    view.

## Try It

Paste one of these prompts into your first chat:

```text
Help me plan a calm, realistic morning routine for weekdays.
```

```text
Turn these scattered thoughts into a simple three-part plan: eat better, sleep earlier, spend less.
```

```text
Ask me a few questions, then help me choose a weekend project I can finish in two hours.
```

## Constraints And Gotchas

- `Workspace` mode requires a folder before onboarding can finish.
- `ChatGPT Subscription` does not ask for an API key during onboarding.
- If setup fails, onboarding stays open and shows the failure instead of
  dropping you into an incomplete chat.
- The model name shown in the composer updates after onboarding completes.

## Related Guides

- [Choose Simple or Workspace mode](simple-vs-workspace-mode.md)
- [Configure model providers, API keys, ChatGPT auth, and reasoning effort](model-providers-api-keys-and-reasoning.md)
- [Manage sessions](sessions.md)
