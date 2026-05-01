# Configure Model Providers, API Keys, ChatGPT Auth, And Reasoning Effort

## What This Is For

Model settings control which provider and model the desktop app uses. The same
section stores API keys, manages ChatGPT subscription login, tests API-key
connections, and sets model reasoning effort when supported.

## When To Use It

Use these settings during first setup, when switching providers, when rotating
keys, when signing into or out of a ChatGPT subscription, or when tuning
reasoning effort for a task.

## Steps

1. Open Settings with `Cmd+,`, `Ctrl+,`, the sidebar `Settings` button, or the
   command palette.
2. Choose `Model & API Keys`.
3. Select a provider: `Anthropic`, `OpenAI`, `ChatGPT Subscription`, or
   `OpenAI-compatible`.
4. For API-key providers, enter the API key and save it.
5. For `OpenAI-compatible`, enter `Base URL`.
6. Enter or select the model name.
7. If `Reasoning Effort` is shown, choose a value or leave it disabled.
8. For API-key providers, click `Test Connection`.
9. For `ChatGPT Subscription`, click `Sign in with ChatGPT` and complete the
   browser sign-in. Use `Sign out` to disconnect.

## Try It

After changing providers or reasoning effort, compare answers with prompts like:

```text
Give me a thoughtful but concise plan for deciding whether to buy or rent a car.
```

```text
Think through the tradeoffs and help me choose between cooking at home more often or using a meal service.
```

```text
Explain this simply: how should I prioritize urgent tasks versus important tasks?
```

## Constraints And Gotchas

- `ChatGPT Subscription` uses external sign-in instead of an API key field.
- `OpenAI-compatible` requires a base URL such as `https://api.example.com/v1`.
- Reasoning effort appears only for models the app recognizes as reasoning
  models.
- OpenAI reasoning supports `minimal`, `low`, `medium`, and `high`; OpenAI
  `max` is clamped to `high`.
- Anthropic adaptive reasoning supports `low`, `medium`, `high`, and `max`.
- The composer also has a reasoning chip for quick changes when the active
  model supports reasoning.

## Related Guides

- [Get started and complete onboarding](getting-started-and-onboarding.md)
- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
- [Configure desktop appearance, permissions, skills, RSI, and memory](desktop-settings.md)
