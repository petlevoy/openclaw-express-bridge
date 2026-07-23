/**
 * eXpress channel message actions adapter — implements message tool actions.
 *
 * BotX API supports sending text notifications. Edit and delete are not
 * supported via the standard notifications endpoint.
 */

import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";

import { listExpressAccountIds, resolveExpressAccount } from "./accounts.js";
import { sendExpressMediaMessage, sendExpressMessage } from "./send.js";

const providerId = "express";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listExpressAccountIds(cfg)
    .map((accountId) => resolveExpressAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

function readTargetParam(
  params: Record<string, unknown>,
  required = true,
): string | undefined {
  return (
    readStringParam(params, "to") ??
    readStringParam(params, "target") ??
    readStringParam(params, "chatId") ??
    readStringParam(params, "channelId", { required })
  );
}

export const expressMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    return {
      actions: ["send"],
      capabilities: [] as unknown as readonly (
        "presentation" | "delivery-pin"
      )[],
    };
  },

  extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
    let to =
      typeof args.target === "string"
        ? args.target
        : typeof args.to === "string"
          ? args.to
          : typeof args.chatId === "string"
            ? args.chatId
            : typeof args.channelId === "string"
              ? args.channelId
              : undefined;
    if (!to) {
      to =
        typeof args.messageId === "string" ? "__message_action__" : undefined;
    }
    if (!to) {
      return null;
    }
    // Strip provider prefix
    if (to.startsWith("express:")) to = to.slice(8);
    const accountId =
      typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },

  /**
   * Keep generic sends on OpenClaw's durable outbound path. In particular,
   * media/filePath/attachments must reach channel.outbound.sendMedia instead
   * of the compatibility action below, which only owns legacy text sends.
   */
  prepareSendPayload: ({ ctx, payload }) =>
    ctx.action === "send" ? payload : null,

  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveExpressAccount({ cfg, accountId });
    if (!account.configured) {
      throw new Error(
        "eXpress account not configured (botId/secretKey/ctsUrl missing)",
      );
    }

    const stripPrefix = (val: string | undefined): string | undefined => {
      if (!val) return val;
      return val.startsWith("express:") ? val.slice(8) : val;
    };

    if (action === "send") {
      const to = stripPrefix(readTargetParam(params))!;
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const replyTo = readStringParam(params, "replyTo");
      const mediaPath =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });

      if (mediaPath) {
        const result = await sendExpressMediaMessage(to, content, mediaPath, {
          cfg,
          accountId: account.accountId,
          replyToId: replyTo ?? undefined,
        });
        if (!result.messageId) {
          throw new Error("eXpress media send returned no message id");
        }
        return jsonResult({ ok: true, to, messageId: result.messageId });
      }
      if (!content.trim()) {
        throw new Error("eXpress send requires a message or media");
      }

      const result = await sendExpressMessage(to, content, {
        cfg,
        accountId: account.accountId,
        replyToId: replyTo ?? undefined,
      });
      if (!result.messageId) {
        throw new Error("eXpress text send returned no message id");
      }
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    if (action === "edit") {
      throw new Error(
        `Action ${action} is not supported for provider ${providerId}.`,
      );
    }

    if (action === "delete") {
      throw new Error(
        `Action ${action} is not supported for provider ${providerId}.`,
      );
    }

    if (action === "sticker") {
      throw new Error(
        `Action ${action} is not supported for provider ${providerId}.`,
      );
    }

    if (action === "sendAttachment") {
      throw new Error(
        `Action ${action} is not supported for provider ${providerId}.`,
      );
    }

    throw new Error(
      `Action ${action} is not supported for provider ${providerId}.`,
    );
  },
};
