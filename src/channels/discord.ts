import fs from 'fs';
import path from 'path';

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudioBuffer } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  /** Remembers the last-active channel per guild for reply routing when
   *  a guild-level registration (dc:guild:<guildId>) is used. */
  private guildLastChannel = new Map<string, string>();
  /** Per-jid re-send timers. Discord's sendTyping() shows the indicator for
   *  ~10s; long agent replies need periodic refreshes so the indicator
   *  doesn't vanish mid-thought. */
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private static readonly TYPING_REFRESH_MS = 8000;

  /** Download a Discord attachment to the group's attachments directory.
   *  Returns the container-relative path (e.g. /workspace/group/attachments/<name>)
   *  or null if the download fails. Matches the Telegram channel pattern
   *  so the agent can actually read the file rather than seeing a bare
   *  "[File: name]" placeholder. */
  private async downloadAttachment(
    url: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    try {
      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(attachDir, safeName);
      const resp = await fetch(url);
      if (!resp.ok) {
        logger.warn(
          { url, status: resp.status },
          'Discord attachment download failed',
        );
        return null;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
      logger.info({ dest: destPath }, 'Discord attachment downloaded');
      return `/workspace/group/attachments/${safeName}`;
    } catch (err) {
      logger.error({ url, err }, 'Failed to download Discord attachment');
      return null;
    }
  }

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups.
      // Fallback: if the specific channel isn't registered, check for a
      // guild-level registration (dc:guild:<guildId>) — lets the bot respond
      // in every channel of a server with a single registration. We also
      // remember the last-active channel per guild so outbound replies land
      // in the correct channel.
      const groups = this.opts.registeredGroups();
      let group = groups[chatJid];
      let effectiveJid = chatJid;
      if (!group && message.guild) {
        const guildJid = `dc:guild:${message.guild.id}`;
        if (groups[guildJid]) {
          group = groups[guildJid];
          effectiveJid = guildJid;
          this.guildLastChannel.set(message.guild.id, channelId);
          // Ensure the guild JID has a chats row so FK constraints succeed.
          this.opts.onChatMetadata(
            effectiveJid,
            timestamp,
            message.guild.name,
            'discord',
            true,
          );
        }
      }
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Attachment handling — audio is transcribed inline; everything else
      // is downloaded into the group's attachments/ so the container agent
      // can actually open the file, matching the Telegram behavior.
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          const name = att.name || 'attachment';
          if (contentType.startsWith('audio/')) {
            try {
              const resp = await fetch(att.url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const buf = Buffer.from(await resp.arrayBuffer());
              const transcript = await transcribeAudioBuffer(buf);
              if (transcript) {
                attachmentDescriptions.push(`[Voice: ${transcript}]`);
                logger.info(
                  { length: transcript.length, filename: att.name },
                  'Transcribed Discord audio attachment',
                );
              } else {
                attachmentDescriptions.push(
                  `[Audio: ${name} — transcription unavailable]`,
                );
              }
            } catch (err) {
              logger.error(
                { err, url: att.url },
                'Discord audio transcription failed',
              );
              attachmentDescriptions.push(
                `[Audio: ${name} — transcription failed]`,
              );
            }
          } else {
            const localPath = await this.downloadAttachment(
              att.url,
              group.folder,
              name,
            );
            const label = contentType.startsWith('image/')
              ? 'Image'
              : contentType.startsWith('video/')
                ? 'Video'
                : 'File';
            attachmentDescriptions.push(
              localPath
                ? `[${label}: ${name} — saved to ${localPath}]`
                : `[${label}: ${name} — download failed]`,
            );
          }
        }
        content = content
          ? `${content}\n${attachmentDescriptions.join('\n')}`
          : attachmentDescriptions.join('\n');
      }

      // Route both store and process under effectiveJid (may be the guild).
      this.opts.onMessage(effectiveJid, {
        id: msgId,
        chat_jid: effectiveJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /** Resolve a nanoclaw JID to the Discord channel we should act on.
   *  Handles both `dc:<channelId>` and `dc:guild:<guildId>` forms; the
   *  latter falls back to the last-active channel or the guild's system
   *  channel. Returns null if no channel can be determined. */
  private async resolveChannelId(jid: string): Promise<string | null> {
    if (!this.client) return null;
    if (jid.startsWith('dc:guild:')) {
      const guildId = jid.replace(/^dc:guild:/, '');
      const last = this.guildLastChannel.get(guildId);
      if (last) return last;
      try {
        const guild = await this.client.guilds.fetch(guildId);
        return guild.systemChannelId ?? null;
      } catch {
        return null;
      }
    }
    return jid.replace(/^dc:/, '');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = await this.resolveChannelId(jid);
      if (!channelId) {
        logger.warn({ jid }, 'Guild has no last-active or system channel');
        return;
      }

      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        { jid, channelId, length: text.length },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  // Discord's per-message upload cap is 25 MB on non-boosted guilds.
  private static readonly MAX_FILE_BYTES = 25 * 1024 * 1024;
  private static readonly MAX_FILES_PER_MESSAGE = 10;

  async sendFiles(
    jid: string,
    text: string,
    filePaths: string[],
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }
    try {
      const channelId = await this.resolveChannelId(jid);
      if (!channelId) {
        logger.warn({ jid }, 'Guild has no last-active or system channel');
        return;
      }
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }
      const textChannel = channel as TextChannel;

      const valid: AttachmentBuilder[] = [];
      const skipped: string[] = [];
      for (const p of filePaths) {
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) {
            skipped.push(`${path.basename(p)} (not a file)`);
            continue;
          }
          if (st.size > DiscordChannel.MAX_FILE_BYTES) {
            skipped.push(`${path.basename(p)} (exceeds 25MB)`);
            continue;
          }
          valid.push(new AttachmentBuilder(p, { name: path.basename(p) }));
        } catch (err) {
          logger.warn({ p, err }, 'Discord attachment not readable');
          skipped.push(`${path.basename(p)} (unreadable)`);
        }
      }

      const suffix = skipped.length ? `\n_Skipped: ${skipped.join(', ')}_` : '';
      let caption = (text || '') + suffix;

      if (valid.length === 0) {
        if (caption.trim()) await textChannel.send(caption.slice(0, 2000));
        return;
      }

      // Discord allows up to 10 files per message; chunk if more.
      for (
        let i = 0;
        i < valid.length;
        i += DiscordChannel.MAX_FILES_PER_MESSAGE
      ) {
        const batch = valid.slice(i, i + DiscordChannel.MAX_FILES_PER_MESSAGE);
        const batchCaption = i === 0 ? caption : '';
        await textChannel.send({
          content: batchCaption ? batchCaption.slice(0, 2000) : undefined,
          files: batch,
        });
      }
      logger.info(
        { jid, channelId, fileCount: valid.length, skipped: skipped.length },
        'Discord files sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord files');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    for (const timer of this.typingIntervals.values()) clearInterval(timer);
    this.typingIntervals.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    const sendOnce = async () => {
      try {
        const channelId = await this.resolveChannelId(jid);
        if (!channelId) return;
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await sendOnce();
    // Discord shows the indicator for ~10s; refresh while the reply is pending
    // so the user keeps seeing "Bottis is typing..." until setTyping(jid,false).
    if (!this.typingIntervals.has(jid)) {
      const timer = setInterval(sendOnce, DiscordChannel.TYPING_REFRESH_MS);
      this.typingIntervals.set(jid, timer);
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
