# Attach Files And Images

## What This Is For

Attachments let you send local files or supported images with a message. The
agent receives the file paths and image metadata as part of the turn.

## When To Use It

Use attachments when a task depends on a local document, screenshot, image, log,
or source file that the agent should consider with your prompt.

## Steps

1. Click `Attach files` in the composer.
2. Select one or more files.
3. Review the attachment chips above the composer.
4. Remove any unwanted attachment with its remove button.
5. Type your message and send it.
6. Alternatively, drag files into the chat area to attach them.

## Try It

Attach a photo, screenshot, or document and paste one of these prompts:

```text
Describe what stands out in this image and suggest three practical next steps.
```

```text
Summarize this document for someone who only has two minutes.
```

```text
Find anything confusing in this screenshot and suggest clearer wording.
```

## Constraints And Gotchas

- Image previews are supported for JPG, PNG, and WebP.
- Other potential image formats, such as GIF, BMP, TIFF, AVIF, HEIC, and HEIF,
  may be rejected with a visible attachment error.
- Duplicate attachment paths are de-duplicated.
- Attachments are sent when you send the message. Removing a chip before sending
  excludes that file.

## Related Guides

- [Send messages, stop runs, steer runs, and read status badges](messages-runs-and-status.md)
- [Choose Simple or Workspace mode](simple-vs-workspace-mode.md)
