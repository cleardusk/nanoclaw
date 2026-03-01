import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { AppMentionEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;
const WORKSPACE_GROUP_FILE_RE = /`?(\/workspace\/group\/[^\s`"'<>]+)`?/gi;
const SUPPORTED_WORKSPACE_UPLOAD_EXTS = new Set([
  '.html',
  '.htm',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.zip',
]);

interface InboundMessageEvent {
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel_type?: string;
}

type HandledSlackEvent = InboundMessageEvent | AppMentionEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private processingIndicatorsByJid = new Map<string, string[]>();
  private processingEmoji = 'technologist'; // default emoji for processing indicator, can be overridden by .env

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_PROCESSING_EMOJI',
    ]);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }
    if (env.SLACK_PROCESSING_EMOJI) {
      this.processingEmoji = env.SLACK_PROCESSING_EMOJI.trim();
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all subtypes.
    // We normalize message_replied (thread reply wrapper) into a regular message.
    this.app.event('message', async ({ event }) => {
      const normalized = this.normalizeInboundMessageEvent(
        event as unknown as Record<string, unknown>,
      );
      if (!normalized) return;
      await this.handleInboundEvent(normalized);
    });

    // In channel mentions are delivered as a dedicated app_mention event.
    // Handle it explicitly so "@nanoclaw ..." always reaches the router.
    this.app.event('app_mention', async ({ event }) => {
      await this.handleInboundEvent(event as AppMentionEvent);
    });
  }

  private async handleInboundEvent(event: HandledSlackEvent): Promise<void> {
    if (!event.text) return;

    // Threaded replies are flattened into the channel conversation.
    // The agent sees them alongside channel-level messages; responses
    // always go to the channel, not back into the thread.
    const jid = `slack:${event.channel}`;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
    const isGroup = !('channel_type' in event && event.channel_type === 'im');

    // Always report metadata for group discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

    // Only deliver full messages for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const isBotMessage = !!event.bot_id || event.user === this.botUserId;

    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      senderName =
        (await this.resolveUserName(event.user || '')) ||
        event.user ||
        'unknown';
    }

    // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
    // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
    // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
    let content = event.text;
    if (this.botUserId && !isBotMessage) {
      const mentionPattern = `<@${this.botUserId}>`;
      if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(jid, {
      id: event.ts,
      chat_jid: jid,
      sender: event.user || event.bot_id || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  private normalizeInboundMessageEvent(
    event: Record<string, unknown>,
  ): InboundMessageEvent | null {
    const subtype =
      typeof event.subtype === 'string' ? (event.subtype as string) : undefined;

    // Regular messages and bot_message can be consumed directly.
    if (!subtype || subtype === 'bot_message') {
      if (typeof event.channel !== 'string' || typeof event.ts !== 'string') {
        return null;
      }
      return {
        channel: event.channel,
        ts: event.ts,
        text: typeof event.text === 'string' ? event.text : undefined,
        user: typeof event.user === 'string' ? event.user : undefined,
        bot_id: typeof event.bot_id === 'string' ? event.bot_id : undefined,
        channel_type:
          typeof event.channel_type === 'string'
            ? event.channel_type
            : undefined,
      };
    }

    // Thread replies can arrive wrapped as subtype=message_replied with the
    // actual user reply under event.message.
    if (subtype === 'message_replied') {
      const nested =
        event.message && typeof event.message === 'object'
          ? (event.message as Record<string, unknown>)
          : null;
      if (!nested) return null;
      if (typeof event.channel !== 'string') return null;
      if (typeof nested.ts !== 'string') return null;
      return {
        channel: event.channel,
        ts: nested.ts,
        text: typeof nested.text === 'string' ? nested.text : undefined,
        user: typeof nested.user === 'string' ? nested.user : undefined,
        bot_id: typeof nested.bot_id === 'string' ? nested.bot_id : undefined,
        channel_type:
          typeof event.channel_type === 'string'
            ? event.channel_type
            : undefined,
      };
    }

    return null;
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      await this.sendSlackPayload(jid, channelId, text);
      await this.clearOneProcessingIndicator(jid);

      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  async setProcessingIndicator(
    jid: string,
    messageId: string,
    isProcessing: boolean,
  ): Promise<void> {
    if (!this.connected) return;
    if (!this.ownsJid(jid)) return;
    if (!messageId) return;

    const channelId = jid.replace(/^slack:/, '');
    if (isProcessing) {
      try {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: messageId,
          name: this.processingEmoji,
        });
        this.trackProcessingIndicator(jid, messageId);
      } catch (err) {
        logger.debug(
          { jid, messageId, emoji: this.processingEmoji, err },
          'Failed to add Slack processing reaction',
        );
      }
      return;
    }

    this.untrackProcessingIndicator(jid, messageId);
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name: this.processingEmoji,
      });
    } catch (err) {
      logger.debug(
        { jid, messageId, emoji: this.processingEmoji, err },
        'Failed to remove Slack processing reaction',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.sendSlackPayload(item.jid, channelId, item.text);
        await this.clearOneProcessingIndicator(item.jid);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendSlackPayload(
    jid: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const workspaceFilePaths = this.extractWorkspaceGroupFilePaths(text);
    if (workspaceFilePaths.length === 0) {
      await this.postTextInChunks(channelId, text);
      return;
    }

    const uploadedFileNames = await this.uploadWorkspaceGroupFiles(
      jid,
      channelId,
      workspaceFilePaths,
    );

    if (uploadedFileNames.length > 0) {
      // Attachment-only mode: if at least one file is uploaded, do not send text.
      return;
    }

    await this.postTextInChunks(
      channelId,
      '检测到文件路径，但上传失败。请稍后重试。',
    );
  }

  private trackProcessingIndicator(jid: string, messageId: string): void {
    const existing = this.processingIndicatorsByJid.get(jid) || [];
    if (!existing.includes(messageId)) {
      existing.push(messageId);
      this.processingIndicatorsByJid.set(jid, existing);
    }
  }

  private untrackProcessingIndicator(jid: string, messageId: string): void {
    const existing = this.processingIndicatorsByJid.get(jid);
    if (!existing || existing.length === 0) return;
    const filtered = existing.filter((id) => id !== messageId);
    if (filtered.length === 0) {
      this.processingIndicatorsByJid.delete(jid);
    } else {
      this.processingIndicatorsByJid.set(jid, filtered);
    }
  }

  private popOldestProcessingIndicator(jid: string): string | undefined {
    const existing = this.processingIndicatorsByJid.get(jid);
    if (!existing || existing.length === 0) return undefined;
    const [oldest, ...rest] = existing;
    if (rest.length === 0) {
      this.processingIndicatorsByJid.delete(jid);
    } else {
      this.processingIndicatorsByJid.set(jid, rest);
    }
    return oldest;
  }

  private async clearOneProcessingIndicator(jid: string): Promise<void> {
    const messageId = this.popOldestProcessingIndicator(jid);
    if (!messageId) return;
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name: this.processingEmoji,
      });
    } catch (err) {
      logger.debug(
        { jid, messageId, emoji: this.processingEmoji, err },
        'Failed to clear Slack processing reaction after response',
      );
    }
  }

  private async postTextInChunks(
    channelId: string,
    text: string,
  ): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.app.client.chat.postMessage({ channel: channelId, text });
      return;
    }

    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: text.slice(i, i + MAX_MESSAGE_LENGTH),
      });
    }
  }

  private extractWorkspaceGroupFilePaths(text: string): string[] {
    const paths = new Set<string>();
    for (const match of text.matchAll(WORKSPACE_GROUP_FILE_RE)) {
      const p = match[1];
      if (!p) continue;
      const normalizedPath = path.posix.normalize(p);
      if (this.isSupportedWorkspaceUploadPath(normalizedPath)) {
        paths.add(normalizedPath);
      }
    }
    return [...paths];
  }

  private isSupportedWorkspaceUploadPath(workspacePath: string): boolean {
    const lower = workspacePath.toLowerCase();
    for (const ext of SUPPORTED_WORKSPACE_UPLOAD_EXTS) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  private resolveHostPathFromWorkspacePath(
    jid: string,
    workspacePath: string,
  ): string | undefined {
    const group = this.opts.registeredGroups()[jid];
    if (!group) return undefined;

    const normalized = path.posix.normalize(workspacePath);
    const prefix = '/workspace/group/';
    if (!normalized.startsWith(prefix)) return undefined;

    const relativePath = normalized.slice(prefix.length);
    if (
      !relativePath ||
      relativePath.startsWith('../') ||
      relativePath.includes('/../')
    ) {
      return undefined;
    }

    const groupDir = resolveGroupFolderPath(group.folder);
    return path.resolve(groupDir, relativePath);
  }

  private async uploadWorkspaceGroupFiles(
    jid: string,
    channelId: string,
    workspaceFilePaths: string[],
  ): Promise<string[]> {
    const uploaded: string[] = [];

    for (const workspacePath of workspaceFilePaths) {
      if (!this.isSupportedWorkspaceUploadPath(workspacePath)) {
        logger.warn(
          { jid, workspacePath },
          'Referenced file extension is not supported for Slack upload',
        );
        continue;
      }

      const hostPath = this.resolveHostPathFromWorkspacePath(
        jid,
        workspacePath,
      );
      if (!hostPath) {
        logger.warn(
          { jid, workspacePath },
          'Could not resolve workspace file path for Slack upload',
        );
        continue;
      }

      if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isFile()) {
        logger.warn(
          { jid, workspacePath, hostPath },
          'Referenced file does not exist on host, skipping Slack upload',
        );
        continue;
      }

      const fileName = path.basename(hostPath);
      try {
        await this.app.client.files.uploadV2({
          channel_id: channelId,
          file: fs.createReadStream(hostPath),
          filename: fileName,
          title: fileName,
        });
        uploaded.push(fileName);
        logger.info(
          { jid, workspacePath, hostPath, fileName },
          'Uploaded file to Slack',
        );
      } catch (err) {
        logger.warn(
          { jid, workspacePath, hostPath, err },
          'Failed to upload file to Slack',
        );
      }
    }

    return uploaded;
  }
}
