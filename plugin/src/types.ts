/**
 * BotX API — TypeScript type definitions
 * https://express.ms/botx-api-docs
 */

// ─── Incoming webhook payload ─────────────────────────────────

export interface BotXCommandPayload {
  /** Unique sync ID for this command */
  sync_id: string;
  /** Bot ID */
  bot_id: string;
  /** Command body */
  command: BotXCommand;
  /** Sender info */
  from: BotXSender;
  /** Async files */
  async_files?: BotXAsyncFile[];
}

export interface BotXCommand {
  body: BotXCommandBody;
  command_type: "user" | "system";
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface BotXCommandBody {
  /** Raw message text */
  body: string;
  /** Attachments */
  attachments?: BotXAttachment[];
}

export interface BotXAttachment {
  type: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BotXAsyncFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
  file_url?: string;
  file_hash?: string;
  kind?: string;
}

export interface BotXSender {
  /** Sender UUID (user id) */
  huid: string;
  /** Chat UUID */
  chat_id: string;
  /** Sender display name */
  username?: string;
  /** Sender full name */
  user_kinds?: string[];
  /** User device type */
  device?: string;
}

// ─── Token response ────────────────────────────────────────────

export interface BotXTokenResponse {
  /** JWT access token */
  result: string;
  /** Status code */
  status: "ok" | "error";
  errors?: string[];
}

// ─── Send notification response ────────────────────────────────

export interface BotXNotificationResponse {
  status: "ok" | "error";
  result?: {
    sync_id: string;
  };
  errors?: string[];
}

// ─── BotX file metadata ────────────────────────────────────────

export interface BotXFileMetadata {
  file_id: string;
  file_name: string;
  file_size: number;
  file_url: string;
  file_hash?: string;
  kind?: string;
  mime_type?: string;
}

// ─── Notification callback payload ─────────────────────────────

export interface BotXNotificationCallback {
  notification_id: string;
  source: string;
  group_chat_id: string;
  status: "ok" | "error";
  errors?: string[];
  body?: Record<string, unknown>;
}

// ─── Account config ────────────────────────────────────────────

export interface ExpressAccountConfig {
  enabled?: boolean;
  /** Transport backend. BotX remains the default for backward compatibility. */
  mode?: "botx" | "desktop";
  /** Bot UUID from eXpress admin */
  botId?: string;
  /** Secret key for token generation */
  secretKey?: string;
  /** CTS server URL, e.g. https://cts.example.com */
  ctsUrl?: string;
  /** Deprecated compatibility field; BotX inbound does not open a listener. */
  webhookPort?: number;
  /** DM policy */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** OpenClaw Markdown rendering preferences accepted by the host schema. */
  markdown?: { tables?: "off" | "code" | "block" | "bullets" };
  /** Per-action access policy accepted by the host channel schema. */
  actions?: Record<
    string,
    boolean | "pairing" | "allowlist" | "open" | undefined
  >;
  /** Allowed sender HUIDs */
  allowFrom?: string[];
  /** Account display name */
  name?: string;
  /** Streaming mode */
  streamMode?: "off" | "partial" | "block";
  /** Media max size in MB */
  mediaMaxMb?: number;
  /** Text chunk limit */
  textChunkLimit?: number;
  /** Loopback Chrome DevTools endpoint exposed by the official desktop client. */
  desktopCdpUrl?: string;
  /** Exact allowlisted eXpress group chat UUID. */
  desktopChatId?: string;
  /** Exact allowlisted title shown by the desktop client. */
  desktopChatTitle?: string;
  /** Exact HUID of the only accepted remote sender. */
  desktopSenderId?: string;
  /** Optional display name used in OpenClaw envelopes. */
  desktopSenderName?: string;
  /** Poll interval for the already-decrypted desktop DOM. */
  desktopPollIntervalMs?: number;
  /** Persistent deduplication state path. */
  desktopStatePath?: string;
  /** Master configuration gate for desktop outbound delivery. */
  desktopOutboundEnabled?: boolean;
  /** A second, file-based outbound interlock checked for every send. */
  desktopOutboundSwitchPath?: string;
  /** Additional roots from which desktop outbound files may be attached. */
  desktopMediaRoots?: string[];
}

export interface ExpressChannelConfig {
  enabled?: boolean;
  mode?: "botx" | "desktop";
  accounts?: Record<string, ExpressAccountConfig>;
  defaultAccount?: string;
  /** Legacy top-level fields */
  botId?: string;
  secretKey?: string;
  ctsUrl?: string;
  webhookPort?: number;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  markdown?: { tables?: "off" | "code" | "block" | "bullets" };
  actions?: Record<
    string,
    boolean | "pairing" | "allowlist" | "open" | undefined
  >;
  allowFrom?: string[];
  desktopCdpUrl?: string;
  desktopChatId?: string;
  desktopChatTitle?: string;
  desktopSenderId?: string;
  desktopSenderName?: string;
  desktopPollIntervalMs?: number;
  desktopStatePath?: string;
  desktopOutboundEnabled?: boolean;
  desktopOutboundSwitchPath?: string;
  desktopMediaRoots?: string[];
}

// NOTE: ResolvedExpressAccount определён в accounts.ts (каноничный источник)
