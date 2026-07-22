/**
 * Outbound message sending for eXpress (BotX API).
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveExpressAccount } from "./accounts.js";
import { sendMessageWithRefresh } from "./api.js";
import {
  DEFAULT_DESKTOP_MEDIA_MAX_MB,
  sendExpressDesktopFile,
  sendExpressDesktopMessage,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";
import { toPlainText } from "./format.js";

export interface ExpressSendOptions {
  accountId?: string;
  cfg?: OpenClawConfig;
  /** Reply-to sync_id */
  replyToId?: string;
  /** Format hint (BotX currently only supports plain text) */
  format?: "plain" | "markdown";
}

/**
 * Resolve account credentials from options or config.
 */
function resolveCredentials(opts: ExpressSendOptions): {
  ctsUrl: string;
  botId: string;
  secretKey: string;
  accountId: string;
} {
  if (opts.cfg) {
    const account = resolveExpressAccount({
      cfg: opts.cfg,
      accountId: opts.accountId,
    });
    if (!account.configured) {
      throw new Error(`eXpress account ${account.accountId} not configured`);
    }
    return {
      ctsUrl: account.ctsUrl,
      botId: account.botId,
      secretKey: account.secretKey,
      accountId: account.accountId,
    };
  }
  throw new Error("eXpress send: cfg required in options");
}

/**
 * Normalize target — strip "express:" prefix if present.
 */
function normalizeTargetId(to: string): string {
  const normalized = to.startsWith("express:") ? to.slice(8) : to;
  return normalized.trim();
}

/**
 * Send a text message to an eXpress chat.
 */
export async function sendExpressMessage(
  to: string,
  text: string,
  opts: ExpressSendOptions = {},
): Promise<{ messageId: string }> {
  if (opts.cfg) {
    const account = resolveExpressAccount({
      cfg: opts.cfg,
      accountId: opts.accountId,
    });
    if (!account.configured) {
      throw new Error(`eXpress account ${account.accountId} not configured`);
    }
    if (account.mode === "desktop") {
      const chatId = normalizeTargetId(to);
      const safeText = toPlainText(text ?? "").trim();
      if (!safeText) return { messageId: "" };
      const messageId = await sendExpressDesktopMessage(
        account,
        chatId,
        safeText,
      );
      return { messageId };
    }
  }
  const creds = resolveCredentials(opts);
  const chatId = normalizeTargetId(to);

  const safeText = toPlainText(text ?? "").trim();
  if (!safeText) {
    return { messageId: "" };
  }

  const syncId = await sendMessageWithRefresh(
    creds.ctsUrl,
    creds.botId,
    creds.secretKey,
    creds.accountId,
    chatId,
    safeText,
  );

  return { messageId: syncId };
}

/**
 * Send a media message to eXpress. Desktop mode attaches an existing local
 * regular file through the official client's matching file input.
 */
export async function sendExpressMediaMessage(
  to: string,
  caption: string,
  mediaPath: string,
  opts: ExpressSendOptions = {},
): Promise<{ messageId: string }> {
  if (opts.cfg) {
    const account = resolveExpressAccount({
      cfg: opts.cfg,
      accountId: opts.accountId,
    });
    if (!account.configured) {
      throw new Error(`eXpress account ${account.accountId} not configured`);
    }
    if (account.mode === "desktop") {
      const chatId = normalizeTargetId(to);
      await validateDesktopOutboundFile(
        mediaPath,
        account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB,
        account.config.desktopMediaRoots,
      );
      const safeCaption = toPlainText(caption).trim();
      if (safeCaption) {
        await sendExpressDesktopMessage(account, chatId, safeCaption);
      }
      const messageId = await sendExpressDesktopFile(
        account,
        chatId,
        mediaPath,
      );
      return { messageId };
    }
  }
  throw new Error("eXpress BotX outbound file upload is not supported");
}

/**
 * Edit a message in eXpress.
 * BotX API supports editing via PUT /api/v3/botx/notifications/event.
 */
export async function editExpressMessage(
  _messageId: string,
  _text: string,
  _opts: ExpressSendOptions = {},
): Promise<void> {
  // BotX edit API requires event_id and is CTS-specific.
  // Not implemented — placeholder for future API support.
  throw new Error(
    "eXpress editMessage: BotX API does not support message editing via notifications",
  );
}

/**
 * Delete a message in eXpress.
 * BotX API supports deletion via DELETE /api/v3/botx/notifications/event/{event_id}.
 */
export async function deleteExpressMessage(
  _messageId: string,
  _opts: ExpressSendOptions = {},
): Promise<void> {
  // BotX delete API is CTS-specific.
  // Not implemented — placeholder for future API support.
  throw new Error(
    "eXpress deleteMessage: BotX API does not support message deletion via notifications",
  );
}
