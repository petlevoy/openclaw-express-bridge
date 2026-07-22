/** Inbound monitor for the official eXpress Linux client via loopback CDP. */

import { homedir } from "node:os";
import { join } from "node:path";

import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";

import {
  type DesktopAckHandle,
  withDesktopInboundAcknowledgement,
} from "./desktop-ack.js";
import {
  DEFAULT_DESKTOP_MEDIA_MAX_MB,
  desktopClientFromAccount,
  DesktopDedupeStore,
  type DesktopMessage,
  isDesktopOutboundUnlocked,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";
import {
  DesktopDispatchRateLimiter,
  redactDesktopError,
  selectDesktopInboundBatchResilient,
} from "./desktop-safety.js";
import { toPlainText } from "./format.js";
import type { ExpressMonitorOptions } from "./monitor.js";
import { getExpressRuntime } from "./runtime.js";

export const DESKTOP_INBOUND_EVENT_MAX_ATTEMPTS = 3;

export class DesktopInboundAttachmentError extends Error {
  constructor(readonly detail: unknown) {
    super("desktop inbound attachment processing failed");
    this.name = "DesktopInboundAttachmentError";
  }
}

export type DesktopInboundEventOutcome = "delivered" | "retry" | "quarantined";

interface ProcessDesktopInboundEventOptions {
  message: DesktopMessage;
  store: DesktopDedupeStore;
  work: () => Promise<void>;
  maxAttempts?: number;
  onDiagnostic?: (
    outcome: Exclude<DesktopInboundEventOutcome, "delivered">,
    attempt: number,
    diagnostic: string,
  ) => void;
}

/**
 * Isolate a poison attachment from the CDP connection. Attachment failures
 * receive a bounded durable retry and then only that message id is skipped.
 * Transport or OpenClaw dispatch failures still escape to the reconnect path.
 */
export async function processDesktopInboundEvent(
  options: ProcessDesktopInboundEventOptions,
): Promise<DesktopInboundEventOutcome> {
  try {
    await options.work();
    await options.store.add(options.message.id);
    return "delivered";
  } catch (error) {
    if (!(error instanceof DesktopInboundAttachmentError)) throw error;
    const disposition = await options.store.recordFailure(
      options.message.id,
      options.maxAttempts ?? DESKTOP_INBOUND_EVENT_MAX_ATTEMPTS,
    );
    const outcome = disposition.quarantined ? "quarantined" : "retry";
    options.onDiagnostic?.(
      outcome,
      disposition.attempt,
      redactDesktopError(error.detail),
    );
    return outcome;
  }
}

function isDesktopTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^desktop CDP (?:connection|websocket|target list|command timed out)/.test(
      message,
    ) ||
    /^desktop CDP [A-Za-z.]+ failed:/.test(message) ||
    message === "official eXpress desktop page target not found" ||
    message === "official eXpress desktop client is not authenticated" ||
    message === "active desktop chat UUID is not allowlisted" ||
    message === "active desktop chat title is not allowlisted"
  );
}

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
          const batch = selectDesktopInboundBatchResilient(
            snapshot.messages,
            (messageId) => store.has(messageId),
            {
              expectedSenderId: senderId,
              maxMediaBytes: Math.floor(
                (account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB) *
                  1024 *
                  1024,
              ),
            },
          );
          const onDiagnostic = (
            message: DesktopMessage,
            outcome: Exclude<DesktopInboundEventOutcome, "delivered">,
            attempt: number,
            diagnostic: string,
          ) =>
            log?.warn?.(
              `[${account.accountId}] eXpress desktop inbound ${outcome} id=${message.id} type=${message.type} attempt=${attempt}/${DESKTOP_INBOUND_EVENT_MAX_ATTEMPTS}: ${diagnostic}`,
            );
          for (const rejected of batch.rejected) {
            await processDesktopInboundEvent({
              message: rejected.message,
              store,
              work: async () => {
                throw new DesktopInboundAttachmentError(rejected.error);
              },
              onDiagnostic: (outcome, attempt, diagnostic) =>
                onDiagnostic(rejected.message, outcome, attempt, diagnostic),
            });
          }
          for (const message of batch.queued) {
            if (abortSignal.aborted) break;
            await withDesktopInboundAcknowledgement(
              {
                account,
                client,
                targetChatId: chatId,
                claim: () => store.claimAcknowledgement(message.id),
                onActivity: () => statusSink?.({ lastOutboundAt: Date.now() }),
                onError: (kind, error) =>
                  log?.warn?.(
                    `[${account.accountId}] eXpress desktop ${kind} acknowledgement unavailable: ${redactDesktopError(error)}`,
                  ),
              },
              async (acknowledgement) => {
                await sleepWithAbort(rateLimiter.reserve(), abortSignal);
                if (abortSignal.aborted) return;
                await processDesktopInboundEvent({
                  message,
                  store,
                  work: () =>
                    dispatchDesktopInbound(
                      opts,
                      message,
                      client,
                      acknowledgement,
                    ),
                  onDiagnostic: (outcome, attempt, diagnostic) =>
                    onDiagnostic(message, outcome, attempt, diagnostic),
                });
              },
            );
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
  acknowledgement?: DesktopAckHandle,
): Promise<void> {
  const { account, config, log, statusSink } = opts;
  const senderId = account.config.desktopSenderId!;
  const senderName =
    account.config.desktopSenderName ?? account.config.desktopChatTitle;
  const chatId = account.config.desktopChatId!;
  const text = message.text.trim();
  const maxMediaBytes = Math.floor(
    (account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB) * 1024 * 1024,
  );

  const core = getExpressRuntime();
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  let attachmentText = "";
  if (message.attachment) {
    try {
      const downloaded = await client.downloadAttachment(
        message,
        maxMediaBytes,
      );
      const saved = await core.channel.media.saveMediaBuffer(
        downloaded.buffer,
        downloaded.mimeType,
        "inbound",
        maxMediaBytes,
        downloaded.fileName,
      );
      mediaPaths.push(saved.path);
      mediaTypes.push(downloaded.mimeType);
      attachmentText = `[File: ${downloaded.fileName}]`;
    } catch (error) {
      if (isDesktopTransportFailure(error)) throw error;
      throw new DesktopInboundAttachmentError(error);
    }
  }
  if (!text && mediaPaths.length === 0) return;

  statusSink?.({ lastInboundAt: Date.now() });
  log?.info?.(
    `[${account.accountId}] eXpress desktop inbound id=${message.id}`,
  );

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
  const bodyForAgent = [text, attachmentText].filter(Boolean).join("\n");
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
    SenderName: senderName,
    SenderId: senderId,
    Provider: "express",
    Surface: "express",
    MessageSid: message.id,
    MessageSidFull: message.id,
    OriginatingChannel: "express",
    OriginatingTo: `express:${chatId}`,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length ? mediaPaths : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length ? mediaTypes : undefined,
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
        await acknowledgement?.stop();
        if (!(await isDesktopOutboundUnlocked(account))) {
          log?.info?.(
            `[${account.accountId}] eXpress desktop reply withheld by outbound interlock`,
          );
          return;
        }
        if (payload.text?.trim()) {
          const safeText = toPlainText(payload.text).trim();
          const chunks = core.channel.text.chunkText(
            safeText,
            account.config.textChunkLimit ?? 4000,
          );
          for (const chunk of chunks) {
            if (!(await isDesktopOutboundUnlocked(account))) {
              throw new Error(
                "desktop eXpress outbound was locked during reply",
              );
            }
            await client.sendText(chatId, chunk);
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        }
        const media = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        for (const mediaUrl of media) {
          if (!(await isDesktopOutboundUnlocked(account))) {
            throw new Error("desktop eXpress outbound was locked during reply");
          }
          const file = await validateDesktopOutboundFile(
            mediaUrl,
            account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB,
            account.config.desktopMediaRoots,
          );
          if (!(await isDesktopOutboundUnlocked(account))) {
            throw new Error(
              "desktop eXpress outbound was locked during file validation",
            );
          }
          await client.sendFile(chatId, file);
          statusSink?.({ lastOutboundAt: Date.now() });
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
