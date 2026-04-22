import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesForChat,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  listConversations,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  extractAttachments,
  findChannel,
  formatMessages,
  formatOutbound,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Resolve a /reference argument to a specific chat. Accepts:
 *   - a full JID (dc:..., tg:..., wa:...) — matched exactly
 *   - a substring of the chat name — case-insensitive, first match wins
 * Returns null if nothing matches.
 */
function resolveReferenceTarget(
  arg: string,
): { jid: string; name: string; channel: string } | null {
  const all = listConversations();
  const exact = all.find((c) => c.chatJid === arg);
  if (exact) {
    return { jid: exact.chatJid, name: exact.name, channel: exact.channel };
  }
  const q = arg.toLowerCase();
  const nameMatch = all.find((c) => c.name?.toLowerCase().includes(q));
  if (nameMatch) {
    return {
      jid: nameMatch.chatJid,
      name: nameMatch.name,
      channel: nameMatch.channel,
    };
  }
  return null;
}

/**
 * Render a list of messages as a compact context block the agent can
 * reason about. Ordered oldest→newest (getMessagesForChat returns newest-
 * first, so we reverse here).
 */
function formatReferenceBlock(
  target: { name: string; channel: string; jid: string },
  messages: { sender_name?: string; content: string; timestamp: string }[],
): string {
  const lines = messages
    .slice()
    .reverse()
    .map(
      (m) => `[${m.timestamp}] ${m.sender_name || '(unknown)'}: ${m.content}`,
    );
  return (
    `--- Referenced context from "${target.name}" (${target.channel}, ${target.jid}) ---\n` +
    lines.join('\n') +
    `\n--- End reference ---`
  );
}

/**
 * Handler for the /reference <target> user command. Resolves the target,
 * fetches its recent messages, and pipes them into the currently-active
 * agent container via IPC. Non-main groups are restricted to referencing
 * their own chat (same rule as the MCP search/get tools).
 */
async function handleReference(
  arg: string,
  chatJid: string,
  reply: (text: string) => Promise<void> | undefined,
): Promise<void> {
  const target = resolveReferenceTarget(arg);
  if (!target) {
    await reply(
      `No chat matching "${arg}". Try /reference with no argument to list options.`,
    );
    return;
  }
  const requester = registeredGroups[chatJid];
  if (!requester?.isMain && target.jid !== chatJid) {
    await reply(
      '/reference to another chat requires the main group. You can reference your own chat.',
    );
    return;
  }
  const messages = getMessagesForChat(target.jid, { limit: 20 });
  if (messages.length === 0) {
    await reply(`No messages found in "${target.name}".`);
    return;
  }
  const block = formatReferenceBlock(target, messages);
  const piped = queue.sendMessage(chatJid, block);
  if (piped) {
    await reply(
      `📎 Referenced ${messages.length} messages from "${target.name}" — now in context for the running agent.`,
    );
  } else {
    await reply(
      `No active agent session. Send a message first, then /reference "${arg}" again.`,
    );
  }
}

// Centralized outbound path — every source of agent text (message loop,
// MCP send_message via IPC, scheduler results) funnels through this so
// <internal> stripping and <attach> extraction happen in exactly one place.
async function sendAgentOutput(
  channel: Channel,
  chatJid: string,
  rawText: string,
): Promise<boolean> {
  const stripped = formatOutbound(rawText);
  if (!stripped) return false;
  const { text, paths } = extractAttachments(stripped);
  const group = registeredGroups[chatJid];
  if (paths.length > 0 && channel.sendFiles && group) {
    const hostPaths = resolveAttachmentPaths(paths, group.folder);
    await channel.sendFiles(chatJid, text, hostPaths);
    return true;
  }
  if (paths.length > 0) {
    logger.warn(
      { channel: channel.name, paths, hasGroup: !!group },
      'Attachments requested but channel lacks sendFiles or group is unknown; sending text only',
    );
  }
  if (text) {
    await channel.sendMessage(chatJid, text);
    return true;
  }
  return false;
}

// Resolve attach-tag paths to absolute host paths under the group folder.
// Accepts three forms from the agent:
//   /workspace/group/...        → <groupFolder>/...
//   /workspace/extra/<name>/... → rejected (read-only mounts, out of scope here)
//   relative paths (attachments/foo.png) → <groupFolder>/attachments/foo.png
// Paths that escape the group folder are dropped with a warning.
function resolveAttachmentPaths(
  paths: string[],
  groupFolder: string,
): string[] {
  const base = resolveGroupFolderPath(groupFolder);
  const resolved: string[] = [];
  for (const raw of paths) {
    let rel: string;
    if (raw.startsWith('/workspace/group/')) {
      rel = raw.slice('/workspace/group/'.length);
    } else if (raw.startsWith('/workspace/')) {
      logger.warn({ raw }, 'Attachment outside group workspace, skipping');
      continue;
    } else if (path.isAbsolute(raw)) {
      logger.warn(
        { raw },
        'Absolute host paths not allowed in attach, skipping',
      );
      continue;
    } else {
      rel = raw;
    }
    const abs = path.resolve(base, rel);
    const relToBase = path.relative(base, abs);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
      logger.warn({ raw }, 'Attachment path escapes group folder, skipping');
      continue;
    }
    resolved.push(abs);
  }
  return resolved;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      const sent = await sendAgentOutput(channel, chatJid, raw);
      if (sent) outputSentToUser = true;
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Container control commands. Accepts bare "/stop" or variants like
      // "@Bottis /stop" or "/stop@botname" (Telegram group style).
      //   /stop, /restart    — nuclear: kill the container outright
      //   /interrupt         — soft: abort the in-flight query, keep session
      //   /status            — ask the agent for a snapshot
      //   /reference <target> — pipe last 20 messages from another chat in
      //   /help              — list available commands
      const CONTROL_CMD_RE =
        /^(?:@\S+\s+)?\/(stop|restart|interrupt|status|help|reference)(?:@\S+)?(?:\s+(.+?))?\s*$/i;
      const ctrl = trimmed.match(CONTROL_CMD_RE);
      if (ctrl && registeredGroups[chatJid]) {
        const cmd = ctrl[1].toLowerCase();
        const channel = findChannel(channels, chatJid);
        const reply = (text: string) =>
          channel
            ?.sendMessage(chatJid, text)
            .catch((err) =>
              logger.error({ err, chatJid }, 'Control command reply failed'),
            );

        if (cmd === 'help') {
          reply(
            `Commands:\n` +
              `• /stop, /restart — kill the agent container\n` +
              `• /interrupt — abort the current task, keep session\n` +
              `• /status — snapshot of the running agent\n` +
              `• /reference <chat> — pipe last 20 messages from <chat> into the current session\n` +
              `• /help — this message`,
          );
          return;
        }

        if (cmd === 'reference') {
          const arg = ctrl[2]?.trim();
          if (!arg) {
            const isMain = registeredGroups[chatJid]?.isMain;
            if (!isMain) {
              reply('Usage: /reference <chat-name or jid>.');
            } else {
              const chats = listConversations().slice(0, 10);
              const lines = chats.map(
                (c) =>
                  `• ${c.name} (${c.channel}) — ${c.messageCount} msgs — ${c.chatJid}`,
              );
              reply(
                `Usage: /reference <chat-name or jid>\n\nRecent conversations:\n${lines.join('\n')}`,
              );
            }
            return;
          }
          handleReference(arg, chatJid, reply).catch((err) =>
            logger.error({ err, chatJid, arg }, '/reference handler failed'),
          );
          return;
        }

        if (cmd === 'interrupt') {
          const sent = queue.writeIpcEvent(chatJid, { type: 'interrupt' });
          reply(
            sent
              ? '✋ Interrupt sent. The agent will stop after the current step.'
              : 'No active agent to interrupt.',
          );
          return;
        }

        if (cmd === 'status') {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const sent = queue.writeIpcEvent(chatJid, {
            type: 'status-request',
            id,
          });
          if (!sent) {
            reply('No active agent.');
            return;
          }
          // Poll for the snapshot for up to 3 seconds.
          const start = Date.now();
          const tick = () => {
            const snap = queue.readStatusSnapshot(chatJid, id);
            if (snap) {
              const msgs = snap.messageCount ?? '?';
              const elapsedMs = Number(snap.elapsedMs) || 0;
              const elapsedSec = Math.floor(elapsedMs / 1000);
              const session =
                typeof snap.sessionId === 'string'
                  ? ` (session ${snap.sessionId.slice(0, 8)})`
                  : '';
              reply(
                `📊 Agent alive${session} — ${msgs} internal messages, running ${elapsedSec}s`,
              );
              return;
            }
            if (Date.now() - start > 3000) {
              reply(
                '📊 Status request sent; no reply within 3s. Agent may be deep in a tool call.',
              );
              return;
            }
            setTimeout(tick, 250);
          };
          setTimeout(tick, 250);
          return;
        }

        // /stop and /restart — nuclear path (unchanged semantics)
        const stopped = queue.stopActiveContainer(chatJid);
        reply(
          stopped
            ? `🛑 Agent ${cmd === 'stop' ? 'stopped' : 'restarted'}. Send a new message to start again.`
            : `No active agent to ${cmd}.`,
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup: (jid: string, group: RegisteredGroup) =>
      registerGroup(jid, group),
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      await sendAgentOutput(channel, jid, rawText);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await sendAgentOutput(channel, jid, rawText);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
