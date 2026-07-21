/**
 * eXpress monitor — starts webhook server and dispatches incoming commands
 * to the OpenClaw pipeline.
 *
 * BotX API is webhook-only (no long polling), so this is simpler than MAX's
 * hybrid polling/webhook monitor.
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { ResolvedExpressAccount } from "./accounts.js";
import { downloadFile, getCachedToken } from "./api.js";
import { startExpressDesktopMonitor } from "./desktop-monitor.js";
import { getExpressRuntime } from "./runtime.js";
import { sendExpressMessage } from "./send.js";
import { enqueueTask, isHeavyTask } from "./task-queue.js";
import type { BotXCommandPayload } from "./types.js";
import { startWebhookServer } from "./webhook.js";

export interface ExpressMonitorOptions {
  account: ResolvedExpressAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    running?: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  }) => void;
}

export async function startExpressMonitor(
  opts: ExpressMonitorOptions,
): Promise<void> {
  const { account, config, abortSignal, log, statusSink } = opts;

  if (account.mode === "desktop") {
    return startExpressDesktopMonitor(opts);
  }

  if (!account.configured) {
    throw new Error(
      "eXpress account not configured (botId/secretKey/ctsUrl missing)",
    );
  }

  log?.info(
    `[${account.accountId}] Starting eXpress webhook on port ${account.webhookPort}...`,
  );

  const webhookServer = startWebhookServer(account.webhookPort, {
    onCommand: async (payload: BotXCommandPayload) => {
      // Only handle user commands (not system events)
      if (payload.command.command_type !== "user") return;

      const senderId = payload.from.huid;
      const chatId = payload.from.chat_id;
      const text = payload.command.body.body ?? "";

      log?.info?.(
        `[${account.accountId}] from=${senderId} chat=${chatId} text="${text.slice(0, 60)}"`,
      );

      statusSink?.({ lastInboundAt: Date.now() });

      // Allowlist policy check
      const policy = account.config.dmPolicy ?? "pairing";
      if (policy === "allowlist") {
        const allowed = (account.config.allowFrom ?? []).some(
          (entry: string) => {
            const normalized = String(entry)
              .replace(/^express:/i, "")
              .trim();
            return normalized === senderId || normalized === chatId;
          },
        );
        if (!allowed) {
          log?.info?.(
            `[${account.accountId}] message dropped (dmPolicy=allowlist, sender=${senderId})`,
          );
          return;
        }
      }

      // Process attachments
      const attachmentDescriptions: string[] = [];
      const mediaPaths: string[] = [];

      const attachments = payload.command.body.attachments ?? [];
      const asyncFiles = payload.async_files ?? [];

      for (const att of attachments) {
        const attType = att.type ?? "unknown";
        attachmentDescriptions.push(`[${attType}]`);
      }

      for (const file of asyncFiles) {
        if (file.file_url) {
          try {
            const token = await getCachedToken(
              account.ctsUrl,
              account.botId,
              account.secretKey,
              account.accountId,
            );
            const buffer = await downloadFile(
              account.ctsUrl,
              token,
              file.file_url,
            );
            const core = getExpressRuntime();
            const saved = await core.channel.media.saveMediaBuffer(
              buffer,
              file.kind ?? "application/octet-stream",
              "inbound",
              (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
              file.file_name,
            );
            mediaPaths.push(saved.path);
          } catch (err) {
            log?.error?.(
              `[${account.accountId}] Failed to download file: ${String(err)}`,
            );
            attachmentDescriptions.push(
              `[File: ${file.file_name ?? file.file_id}]`,
            );
          }
        } else {
          attachmentDescriptions.push(
            `[File: ${file.file_name ?? file.file_id}]`,
          );
        }
      }

      const attachmentText = attachmentDescriptions.join(" ");
      const hasMedia = mediaPaths.length > 0;
      const fullText = [text.trim(), attachmentText]
        .filter(Boolean)
        .join("\n\n");
      const effectiveText = text.trim() || attachmentText;

      // Skip truly empty messages
      if (!effectiveText && !hasMedia) return;

      // Task queue: heavy tasks → enqueue, reply immediately
      if (!hasMedia && isHeavyTask(fullText)) {
        enqueueTask(chatId, senderId, fullText);
        try {
          await sendExpressMessage(
            chatId,
            "⏳ Понял, это займёт время. Задача принята — пришлю результат как будет готово.",
            {
              cfg: config,
              accountId: account.accountId,
            },
          );
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          log?.error?.(
            `[${account.accountId}] Task queue reply failed: ${String(err)}`,
          );
        }
        return;
      }

      // Resolve agent route
      const core = getExpressRuntime();
      const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "express",
        accountId: account.accountId,
        peer: {
          kind: "direct" as const,
          id: senderId,
        },
      });

      const fromLabel = `user:${senderId}`;
      const storePath = core.channel.session.resolveStorePath(
        config.session?.store,
        {
          agentId: route.agentId,
        },
      );
      const envelopeOptions =
        core.channel.reply.resolveEnvelopeFormatOptions(config);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });

      const bodyForAgent = attachmentText
        ? text.trim()
          ? `${text.trim()}\n${attachmentText}`
          : attachmentText
        : text;

      const body = core.channel.reply.formatAgentEnvelope({
        channel: "eXpress",
        from: fromLabel,
        timestamp: Date.now(),
        previousTimestamp,
        envelope: envelopeOptions,
        body: bodyForAgent,
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: bodyForAgent,
        RawBody: text,
        CommandBody: text || attachmentText,
        From: `express:${senderId}`,
        To: `express:${account.accountId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct" as const,
        ConversationLabel: fromLabel,
        SenderName: payload.from.username ?? undefined,
        SenderId: senderId,
        Provider: "express",
        Surface: "express",
        MessageSid: payload.sync_id,
        MessageSidFull: payload.sync_id,
        OriginatingChannel: "express",
        OriginatingTo: `express:${chatId}`,
        MediaPath: mediaPaths[0],
        MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      });

      // Record session meta
      void core.channel.session
        .recordSessionMetaFromInbound({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
        })
        .catch((err) => {
          log?.error?.(
            `[${account.accountId}] Failed updating session meta: ${String(err)}`,
          );
        });

      // Dispatch through the standard reply pipeline
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg: config,
        agentId: route.agentId,
        channel: "express",
        accountId: route.accountId,
      });

      await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          ...prefixOptions,
          deliver: async (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => {
            if (payload.text) {
              const chunkLimit = account.config.textChunkLimit ?? 4000;
              const chunks = core.channel.text.chunkMarkdownText(
                payload.text,
                chunkLimit,
              );
              for (const chunk of chunks) {
                try {
                  await sendExpressMessage(chatId, chunk, {
                    cfg: config,
                    accountId: account.accountId,
                  });
                  statusSink?.({ lastOutboundAt: Date.now() });
                } catch (err) {
                  log?.error?.(
                    `[${account.accountId}] Send failed: ${String(err)}`,
                  );
                }
              }
            }

            // Handle media URLs
            const mediaList = payload.mediaUrls?.length
              ? payload.mediaUrls
              : payload.mediaUrl
                ? [payload.mediaUrl]
                : [];

            for (const mediaUrl of mediaList) {
              try {
                await sendExpressMessage(chatId, `[Media: ${mediaUrl}]`, {
                  cfg: config,
                  accountId: account.accountId,
                });
                statusSink?.({ lastOutboundAt: Date.now() });
              } catch (err) {
                log?.error?.(
                  `[${account.accountId}] Media send failed: ${String(err)}`,
                );
              }
            }
          },
          onError: (err, info) => {
            log?.error?.(
              `[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        replyOptions: {
          onModelSelected,
        },
      });
    },

    onCallback: async (payload) => {
      log?.debug?.(
        `[${account.accountId}] Notification callback: ${payload.notification_id} status=${payload.status}`,
      );
    },
  });

  log?.info?.(
    `[${account.accountId}] eXpress webhook listening on port ${account.webhookPort}`,
  );

  statusSink?.({
    running: true,
    lastStartAt: Date.now(),
    lastError: null,
  });

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener(
      "abort",
      () => {
        webhookServer.close().catch(() => {});
        log?.info?.(`[${account.accountId}] eXpress webhook stopped.`);
        statusSink?.({
          running: false,
          lastStopAt: Date.now(),
        });
        resolve();
      },
      { once: true },
    );
  });
}
