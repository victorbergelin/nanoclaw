---
name: attachments
description: Send files (images, documents, audio, video) alongside a reply. Currently supported on Discord only. Use when the user asks you to send, share, upload, attach, or generate a file.
---

# Sending file attachments

When you need to deliver a file to the user (an image you generated, a
report you wrote, a log you exported), emit an `<attach>` tag anywhere in
your reply. NanoClaw strips the tag before the message is sent, downloads
the file from the group folder, and uploads it via the channel's native
attachment API.

## Syntax

```
<attach path="relative/or/workspace/path"/>
```

- Relative paths resolve against `/workspace/group/` (the group folder).
- Absolute paths must start with `/workspace/group/`.
- Paths outside the group folder, or paths that don't exist, are dropped.
- Multiple `<attach>` tags in one reply are allowed.

## Example

```
Here's the chart you asked for.
<attach path="attachments/sales-q1.png"/>
```

Or with multiple files:

```
Both logs are attached.
<attach path="logs/api.log"/>
<attach path="logs/worker.log"/>
```

## Channel support

| Channel  | Attachments |
|----------|-------------|
| Discord  | ✅ up to 25 MB per file, 10 files per message |
| WhatsApp | ❌ text only for now |
| Gmail    | ❌ text only for now |
| Telegram | paused       |

If the active channel doesn't support attachments, the tags are stripped
and only the text is sent — mention the file path in the text so the user
can still find it.

## Workflow

1. Produce the file somewhere under `/workspace/group/` (e.g.
   `/workspace/group/attachments/` or a subdirectory you create).
2. Reference it with `<attach path="..."/>` in your reply.
3. Don't base64-encode inline — the tag is enough.
