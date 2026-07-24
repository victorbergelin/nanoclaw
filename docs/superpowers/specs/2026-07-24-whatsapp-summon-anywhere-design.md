# WhatsApp "Summon Anywhere" — Design

**Date:** 2026-07-24
**Author:** Victor + Bottis (Claude Code)
**Status:** Approved (verbal), pending implementation

## Goal

Let Victor — and **only** Victor — type `@Bottis` in **any** WhatsApp chat (group or DM),
even chats NanoClaw has never seen before, and get a reply that everyone in that chat
can see. Nobody else can ever trigger Bottis, even by typing `@Bottis`.

## Context / constraints

- Shared-number mode (`ASSISTANT_HAS_OWN_NUMBER=false`): Bottis runs on Victor's own
  WhatsApp number. Victor's messages are always `fromMe=true`. Bottis's replies go out
  from the same number prefixed `Bottis:` and are detected as bot messages by that prefix.
- Today the WhatsApp channel only **delivers/stores** messages for chats present in
  `registeredGroups` (`whatsapp.ts` ~L303: `if (groups[chatJid])`). Everything else is
  dropped after metadata capture.
- The orchestrator message loop only iterates `Object.keys(registeredGroups)`
  (`index.ts` L659), so a chat must be registered to be processed at all.
- Sessions are keyed by **group folder** (`db.ts` `getSession(groupFolder)`). A shared,
  resumed session for all summons would grow unbounded → the same OOM that already
  happened once. Therefore summon runs must NOT resume a session.

## Decisions (agreed with Victor)

1. **Who can trigger:** only `fromMe` (Victor's number). Others are filtered at the
   channel — their messages are never delivered, so they can never trigger regardless of
   the trigger word. No allowlist entry needed; blocking is structural.
2. **What Bottis stores/sees:** only Victor's `@Bottis` messages and Bottis's own replies.
   **Other people's messages in the group are never stored or seen.** Consequence Victor
   accepted: Bottis cannot read the group conversation; it only knows what Victor tells it
   directly.
3. **Memory model:** all summons share one context folder (`whatsapp_main`) — a single
   Victor↔Bottis thread. Each summon runs **fresh** (no session resume) to avoid session
   growth. Recent context = the last ~20 messages of the Victor↔Bottis thread injected
   into the prompt; deeper history via the existing `search_messages` tool (searches the DB).
4. **Replies:** posted into the originating chat with the `Bottis:` prefix, visible to all.

## Design

### Data model

Add a nullable `summon_only INTEGER DEFAULT 0` column to `registered_groups`
(follows the existing `is_main` / `requires_trigger` migration pattern). `summon_only=1`
marks an auto-registered summon chat.

### WhatsApp channel (`src/channels/whatsapp.ts`)

In the `messages.upsert` handler, compute:
- `fromMe = msg.key.fromMe`
- `isSummon = fromMe && triggerPattern.test(content)` (`@Bottis …`)
- `isBotReply = fromMe && content.startsWith('${ASSISTANT_NAME}:')`

Delivery gate becomes:
- Registered, **not** summon-only → deliver everything (unchanged behavior).
- Registered **summon-only** → deliver only when `isSummon || isBotReply`.
- **Not** registered → deliver only when `isSummon`, and signal the orchestrator to
  auto-register this chat.

Auto-registration signal: the channel calls a new `opts.onSummon(chatJid, name)` callback
(or the orchestrator inspects the delivered message) before/at store time. Chosen approach:
orchestrator-side, in its existing `onMessage` handler (keeps registration logic in one place).

### Orchestrator (`src/index.ts`)

In the `onMessage` handler, before `storeMessage`: if the message is on a WhatsApp chat,
is `fromMe`, matches the trigger, and the chat is **not** already registered, then
auto-register it: `registerGroup(chatJid, { name, folder: 'whatsapp_main', trigger: '@Bottis',
requiresTrigger: true, isMain: false, summonOnly: true })`. This persists to DB and adds it
to the in-memory `registeredGroups`, so the message loop picks it up on the next tick.

For `summon_only` groups, when invoking the agent:
- Do **not** resume a session (pass no `sessionId`; run fresh each time).
- Build the prompt context from the **last N (~20)** messages of the chat (a "last N" DB
  read) rather than only messages-since-cursor, so a fresh run still has recent context.

Everything else (trigger gating at L700, reply routing) already works once the chat is a
non-main, `requiresTrigger` group — because Victor's messages are `fromMe` (bypass the
allowlist) and others' messages never arrive.

### What is intentionally NOT built (YAGNI)

- No allowlist entries (structural channel filtering already restricts to `fromMe`).
- No per-chat folders/sessions (shared `whatsapp_main`, fresh runs).
- No storage of other participants' messages.
- No change to Discord or to existing fully-registered WhatsApp chats.

## Testing

- `whatsapp.test.ts`: delivery gate — summon message from an unregistered chat is delivered;
  a non-summon message from an unregistered chat is dropped; another sender's `@Bottis`
  message (not fromMe) is dropped; in a summon-only registered chat, others' messages are
  dropped while `fromMe @Bottis` and `Bottis:` replies pass.
- Orchestrator: auto-registration creates a `summon_only`, non-main, trigger-required entry;
  summon-only runs do not resume a session.
- Security assertion (explicit test): a non-`fromMe` `@Bottis` message never triggers the agent.

## Rollout

Build, run the test suite, restart the orchestrator (launchd), verify WhatsApp reconnects
and no regression on Discord / existing groups. Live-verify by having Victor summon Bottis
in one real group.
