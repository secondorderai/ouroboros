# Use Slash-Invoked Agent Skills

## What This Is For

Agent Skills are reusable instruction packages discovered by Ouroboros. In the
desktop app, you can choose a skill from the composer by starting a message with
`/`.

## When To Use It

Use a skill when your task matches a known workflow, such as a built-in desktop
skill or a skill added through a configured lookup path.

## Steps

1. Click the composer.
2. Type `/` at the start of the message.
3. Continue typing to filter the `Skill picker`.
4. Use the arrow keys or mouse to choose a skill.
5. Press `Enter` or click the skill to select it.
6. Confirm the `Skill: <name>` chip appears in the bottom row.
7. Write the rest of your prompt and send it.
8. Remove the skill chip if you no longer want to use it for the next message.

## Try It

Open the skill picker with `/`, choose any skill that sounds relevant, then try:

```text
Use this skill to help me turn a vague idea into a short checklist.
```

```text
Use this skill to review my plan and tell me what I might be missing.
```

```text
Use this skill to make the next answer shorter, clearer, and easier to act on.
```

## Constraints And Gotchas

- The slash picker only opens for a leading `/` token before any other prompt
  text.
- Disabled skills are not shown in the prompt picker.
- If no skills are installed, the picker explains that a skill directory with a
  `SKILL.md` file must be added through Settings.
- Skills can also be enabled, disabled, or discovered from Settings.

## Related Guides

- [Configure desktop appearance, permissions, skills, RSI, and memory](desktop-settings.md)
- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
