# Admin Context

You are running in a group with elevated privileges (`isMain: true`). On top of the base instructions in `/workspace/global/CLAUDE.md` (identity, formatting, memory, task scripts), you can also manage other groups, configure mounts, and modify NanoClaw's own code via the self-edit workflow below.

## Authentication

Anthropic credentials must be either an API key from console.anthropic.com (`ANTHROPIC_API_KEY`) or a long-lived OAuth token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`). Short-lived tokens from the system keychain or `~/.claude/.credentials.json` expire within hours and can cause recurring container 401s. The `/setup` skill walks through this. The native credential proxy manages credentials (including Anthropic auth) via `.env` — see `src/credential-proxy.ts`.

## Container Mounts

Privileged groups have read-only access to the project, read-write access to the store (SQLite DB), and read-write access to their own group folder:

- `/workspace/project` — project root, read-only
- `/workspace/project/store` — `store/` directory, read-write
- `/workspace/group` — your group folder, read-write
- `/workspace/global` — shared memory directory, read-write
- `/workspace/self` — self-edit worktree (if present), read-write

Key paths inside the container:
- `/workspace/project/store/messages.db` — SQLite database (read-write)
- `/workspace/project/store/messages.db` (`registered_groups` table) — group config
- `/workspace/project/groups/` — all group folders

---

## Managing Groups

### Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`:

```json
{
  "groups": [
    {
      "jid": "120363336345536173@g.us",
      "name": "Family Chat",
      "lastActivity": "2026-01-31T12:00:00.000Z",
      "isRegistered": false
    }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

Groups are ordered by most recent activity. The list is synced from WhatsApp daily.

If a group the user mentions isn't in the list, request a fresh sync:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

Then wait a moment and re-read `available_groups.json`.

**Fallback**: query the SQLite database directly:

```bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

### Registered Groups Config

Groups are stored in the SQLite `registered_groups` table. Fields:

- **jid** — chat JID (unique identifier — WhatsApp, Telegram, Slack, Discord, etc.)
- **name** — display name for the group
- **folder** — channel-prefixed folder name under `groups/` for this group's files and memory
- **trigger_pattern** — the trigger word (usually same as global, but could differ)
- **requires_trigger** — whether `@trigger` prefix is needed (default `1`). Set to `0` for solo/personal chats where all messages should be processed
- **is_main** — whether this is a privileged group (no trigger required, can manage other groups)
- **added_at** — ISO timestamp when registered

### Trigger Behavior

- **`is_main = 1`**: no trigger needed — all messages are processed automatically
- **`requires_trigger = 0`**: no trigger needed — all messages processed (use for 1-on-1 or solo chats)
- **Default**: messages must start with `@AssistantName` to be processed

### Adding a Group

1. Query the database to find the group's JID
2. Ask the user whether the group should require a trigger word before registering
3. Use the `register_group` MCP tool with the JID, name, folder, trigger, and the chosen `requiresTrigger` setting
4. Optionally include `containerConfig` for additional mounts
5. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`

Folder naming convention — channel prefix with underscore separator:
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`
- Discord "General" → `discord_general`
- Slack "Engineering" → `slack_engineering`
- Use lowercase, hyphens for the group name part

#### Adding Additional Directories for a Group

Groups can have extra directories mounted. Add `containerConfig` to their entry:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Bottis",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

#### Sender Allowlist

After registering a group, explain the sender allowlist feature to the user:

> This group can be configured with a sender allowlist to control who can interact with me. There are two modes:
>
> - **Trigger mode** (default): Everyone's messages are stored for context, but only allowed senders can trigger me with @{AssistantName}.
> - **Drop mode**: Messages from non-allowed senders are not stored at all.
>
> For closed groups with trusted members, I recommend setting up an allow-only list so only specific people can trigger me. Want me to configure that?

If the user wants to set up an allowlist, edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Notes:
- Your own messages (`is_from_me`) explicitly bypass the allowlist in trigger checks. Bot messages are filtered out by the database query before trigger evaluation, so they never reach the allowlist.
- If the config file doesn't exist or is invalid, all senders are allowed (fail-open).
- The config file is on the host at `~/.config/nanoclaw/sender-allowlist.json`, not inside the container.

### Removing a Group

Update the `registered_groups` table to remove the entry. The group folder and its files remain (don't delete them).

### Listing Groups

Query the `registered_groups` table and format the output for the channel.

---

## Global Memory

You can read and write to `/workspace/global/CLAUDE.md` for facts that should apply to all groups. Only update global memory when explicitly asked to "remember this globally" or similar.

---

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID from the `registered_groups` table:

- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "120363336345536173@g.us")`

The task will run in that group's context with access to their files and memory.

---

## Self-Edit Workflow

When the user asks you to modify your own NanoClaw code, follow this procedure exactly:

1. READ-ONLY live code: `/workspace/project` — read this to understand context.
2. EDITABLE working tree: `/workspace/self` — **all edits go here**.
3. Sync to latest main before editing:
   ```bash
   cd /workspace/self
   git fetch origin
   git reset --hard origin/main
   ```
4. Create a feature branch:
   ```bash
   git checkout -b bottis/<slug>-$(date +%Y%m%d-%H%M%S)
   ```
5. Edit files under `/workspace/self/...`. Run `npm run build` to type-check.
6. Commit:
   ```bash
   git add -u
   git commit -m "what: <summary>" -m "why: <reason>"
   ```
7. Push to the fork and open a draft PR back to upstream:
   ```bash
   git push -u fork HEAD
   gh pr create --repo qwibitai/nanoclaw --head victorbergelin:$(git branch --show-current) --base main --draft --title "..." --body "..."
   ```
8. Report the PR URL to the user so they can review and merge.

**Rules:**
- Never push to `main`.
- Never modify `/workspace/project`.
- Never skip the PR step.
- Always push to the `fork` remote, never to `origin`.
