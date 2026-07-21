/** Inbound monitor for the official eXpress Linux client via loopback CDP. */

import { homedir } from "node:os";
import { join } from "node:path";

import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";

import {
  desktopClientFromAccount,
  DesktopDedupeStore,
  type DesktopMessage,
  isDesktopOutboundUnlocked,
} from "./desktop-cdp.js";
import {
  DesktopDispatchRateLimiter,
  redactDesktopError,
  selectDesktopInboundBatch,
} from "./desktop-safety.js";
import type { ExpressMonitorOptions } from "./monitor.js";
import { getExpressRuntime } from "./runtime.js";

function sleepWithAbort(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });
}

export async function startExpressDesktopMonitor(
  opts: ExpressMonitorOptions,
): Promise<void> {
  const { account, abortSignal, log, statusSink } = opts;
  if (!account.configured || account.mode !== "desktop") {
    throw new Error("eXpress desktop account is not fully configured");
  }

  const senderId = account.config.desktopSenderId;
  const chatId = account.config.desktopChatId;
  const chatTitle = account.config.desktopChatTitle;
  if (!senderId || !chatId || !chatTitle)
    throw new Error("eXpress desktop allowlist is incomplete");
  if ((account.config.dmPolicy ?? "pairing") !== "allowlist") {
    throw new Error("eXpress desktop bridge requires dmPolicy=allowlist");
  }
  const allowed = new Set(
    (account.config.allowFrom ?? []).map((entry) =>
      String(entry)
        .replace(/^express:/i, "")
        .trim(),
    ),
  );
  if (!allowed.has(senderId) || !allowed.has(chatId)) {
    throw new Error("eXpress desktop sender and chat must both be allowlisted");
  }

  const statePath =
    account.config.desktopStatePath ??
    join(
      homedir(),
      ".openclaw",
      "express-desktop",
      `${account.accountId}.json`,
    );
  const store = new DesktopDedupeStore(statePath);
  const stateExisted = await store.load();
  let needsBaseline = !stateExisted;
  const pollIntervalMs = account.config.desktopPollIntervalMs ?? 1000;
  const client = desktopClientFromAccount(account);
  const rateLimiter = new DesktopDispatchRateLimiter();
  let reconnectDelayMs = 1000;

  statusSink?.({ running: true, lastStartAt: Date.now(), lastError: null });
  log?.info?.(
    `[${account.accountId}] eXpress desktop bridge started (read allowlist active, outbound interlocked)`,
  );

  try {
    while (!abortSignal.aborted) {
      try {
        let snapshot = await client.snapshot();
        if (snapshot.chatId !== chatId || snapshot.chatTitle !== chatTitle) {
          await client.openAllowedChat();
          await sleepWithAbort(350, abortSignal);
          snapshot = await client.snapshot();
        }
        client.assertSnapshotAllowed(snapshot);
        reconnectDelayMs = 1000;
        statusSink?.({ lastError: null });

        if (needsBaseline) {
          await store.baseline(snapshot.messages.map((message) => message.id));
          needsBaseline = false;
          log?.info?.(
            `[${account.accountId}] eXpress desktop baseline recorded (${snapshot.messages.length} visible inbound ids)`,
          );
        } else {
          const queued = selectDesktopInboundBatch(
            snapshot.messages,
            (messageId) => store.has(messageId),
          );
          for (const message of queued) {
            if (abortSignal.aborted) break;
            await sleepWithAbort(rateLimiter.reserve(), abortSignal);
            if (abortSignal.aborted) break;
            await dispatchDesktopInbound(opts, message, client);
            await store.add(message.id);
          }
        }
        await sleepWithAbort(pollIntervalMs, abortSignal);
      } catch (error) {
        client.close();
        const message = redactDesktopError(error);
        statusSink?.({ lastError: message });
        log?.warn?.(
          `[${account.accountId}] eXpress desktop bridge reconnect: ${message}`,
        );
        await sleepWithAbort(reconnectDelayMs, abortSignal);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      }
    }
  } finally {
    client.close();
    statusSink?.({ running: false, lastStopAt: Date.now() });
    log?.info?.(`[${account.accountId}] eXpress desktop bridge stopped`);
  }
}

async function dispatchDesktopInbound(
  opts: ExpressMonitorOptions,
  message: DesktopMessage,
  client: ReturnType<typeof desktopClientFromAccount>,
): Promise<void> {
  const { account, config, log, statusSink } = opts;
  const senderId = account.config.desktopSenderId!;
  const senderName =
    account.config.desktopSenderName ?? account.config.desktopChatTitle;
  const chatId = account.config.desktopChatId!;
  const text = message.text.trim();
  if (!text) return;

  statusSink?.({ lastInboundAt: Date.now() });
  log?.info?.(
    `[${account.accountId}] eXpress desktop inbound id=${message.id}`,
  );

  const core = getExpressRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "express",
    accountId: account.accountId,
    peer: { kind: "direct" as const, id: senderId },
  });
  const fromLabel = senderName
    ? `${senderName} (${senderId})`
    : `user:${senderId}`;
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
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "eXpress",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `express:${senderId}`,
    To: `express:${account.accountId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "express",
    Surface: "express",
    MessageSid: message.id,
    MessageSidFull: message.id,
    OriginatingChannel: "express",
    OriginatingTo: `express:${chatId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((error) => {
      log?.error?.(
        `[${account.accountId}] Failed updating desktop session meta: ${redactDesktopError(error)}`,
      );
    });

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
        if (!(await isDesktopOutboundUnlocked(account))) {
          log?.info?.(
            `[${account.accountId}] eXpress desktop reply withheld by outbound interlock`,
          );
          return;
        }
        const parts: string[] = [];
        if (payload.text?.trim()) parts.push(payload.text.trim());
        const media = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        for (const mediaUrl of media) parts.push(`[Media: ${mediaUrl}]`);
        for (const part of parts) {
          const chunks = core.channel.text.chunkMarkdownText(
            part,
            account.config.textChunkLimit ?? 4000,
          );
          for (const chunk of chunks) {
            await client.sendText(chatId, chunk);
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        }
      },
      onError: (error, info) => {
        log?.error?.(
          `[${account.accountId}] ${info.kind} desktop reply failed: ${redactDesktopError(error)}`,
        );
      },
    },
    replyOptions: { onModelSelected },
  });
}
