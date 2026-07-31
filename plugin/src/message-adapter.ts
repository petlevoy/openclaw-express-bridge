import { randomUUID } from "node:crypto";

import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendResult,
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceipt,
} from "openclaw/plugin-sdk/channel-message-runtime";

import { resolveExpressAccount } from "./accounts.js";
import {
  DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
  desktopClientFromAccount,
  sendExpressDesktopMessage,
} from "./desktop-cdp.js";
import {
  loadDesktopDeliveryJournal,
  reconcileDesktopDeliveryEntry,
  recordDesktopDeliveryDispatch,
  recordDesktopDeliverySuccess,
  resetDesktopDeliveryEntry,
} from "./desktop-delivery-journal.js";
import { toPlainText } from "./format.js";
import { getExpressRuntime } from "./runtime.js";
import { sendExpressMessage } from "./send.js";

function normalizeTargetId(to: string): string {
  return (to.startsWith("express:") ? to.slice(8) : to).trim();
}

function textReceipt(messageId: string, sentAt = Date.now()): MessageReceipt {
  return {
    primaryPlatformMessageId: messageId,
    platformMessageIds: messageId ? [messageId] : [],
    parts: messageId
      ? [{ platformMessageId: messageId, kind: "text", index: 0 }]
      : [],
    sentAt,
  };
}

function textSendResult(messageId: string): ChannelMessageSendResult {
  return { messageId, receipt: textReceipt(messageId) };
}

function expectedDeliveryTexts(
  ctx: ChannelMessageUnknownSendContext,
): string[] {
  const plannedTexts =
    ctx.renderedBatchPlan?.items
      .map((item) => item.text ?? "")
      .filter((text) => text.trim().length > 0) ?? [];
  const payloadTexts = ctx.payloads
    .map((payload) => payload.text ?? "")
    .filter((text) => text.trim().length > 0);
  const sourceTexts = plannedTexts.length > 0 ? plannedTexts : payloadTexts;
  return sourceTexts.flatMap((text) =>
    getExpressRuntime().channel.text.chunkText(
      toPlainText(text).trim(),
      DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
    ),
  );
}

async function reconcileExpressUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const account = resolveExpressAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
  });
  if (account.mode !== "desktop") {
    return {
      status: "unresolved",
      error: "BotX does not expose exact outbound history reconciliation",
      retryable: true,
    };
  }
  const journal = await loadDesktopDeliveryJournal(account);
  if (!journal) {
    return {
      status: "unresolved",
      error: "desktop delivery reconciliation journal is unavailable",
      retryable: true,
    };
  }
  const chatId = normalizeTargetId(ctx.to);
  const expectedTexts = expectedDeliveryTexts(ctx);
  const entry = journal.entries[ctx.queueId];
  let snapshot;
  if (entry?.attempts.some((attempt) => !attempt.messageId)) {
    const client = desktopClientFromAccount(account);
    try {
      snapshot = await client.snapshotAllowed(chatId);
      client.assertSnapshotAllowed(snapshot, chatId);
    } finally {
      client.close();
    }
  }
  const result = reconcileDesktopDeliveryEntry({
    journal,
    queueId: ctx.queueId,
    enqueuedAt: ctx.enqueuedAt,
    chatId,
    expectedTexts,
    snapshot,
  });
  if (result.status === "not_sent") {
    await resetDesktopDeliveryEntry(account, ctx.queueId);
    return result;
  }
  if (result.status === "unresolved") {
    return { ...result, retryable: true };
  }
  const receipt: MessageReceipt = {
    primaryPlatformMessageId: result.messageIds.at(-1),
    platformMessageIds: result.messageIds,
    parts: result.messageIds.map((messageId, index) => ({
      platformMessageId: messageId,
      kind: "text" as const,
      index,
    })),
    sentAt: ctx.platformSendStartedAt ?? Date.now(),
  };
  return {
    status: "sent",
    messageId: receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const expressMessageAdapter = {
  id: "express",
  durableFinal: {
    capabilities: {
      text: true,
      batch: true,
      reconcileUnknownSend: true,
    },
    reconcileUnknownSendKinds: { text: true, batch: true },
    reconcileUnknownSend: reconcileExpressUnknownSend,
  },
  send: {
    text: async (ctx) => {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const account = resolveExpressAccount({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
      });
      const safeText = toPlainText(ctx.text ?? "").trim();
      if (!safeText) return textSendResult("");

      if (account.mode !== "desktop") {
        await ctx.onPlatformSendDispatch?.();
        const result = await sendExpressMessage(ctx.to, safeText, {
          cfg: ctx.cfg,
          accountId: account.accountId,
        });
        return textSendResult(result.messageId);
      }

      const chatId = normalizeTargetId(ctx.to);
      const attemptId = randomUUID();
      const messageId = await sendExpressDesktopMessage(
        account,
        chatId,
        safeText,
        {
          beforeDispatch: async (snapshot) => {
            if (ctx.signal?.aborted) throw ctx.signal.reason;
            if (ctx.deliveryQueueId) {
              await recordDesktopDeliveryDispatch(account, {
                queueId: ctx.deliveryQueueId,
                chatId,
                attemptId,
                text: safeText,
                baselineOwnMessageIds: snapshot.ownMessages.map(
                  (message) => message.id,
                ),
              });
            }
            await ctx.onPlatformSendDispatch?.();
          },
        },
      );
      if (ctx.deliveryQueueId) {
        await recordDesktopDeliverySuccess(account, {
          queueId: ctx.deliveryQueueId,
          attemptId,
          messageId,
        });
      }
      return textSendResult(messageId);
    },
  },
} satisfies ChannelMessageAdapterShape;
