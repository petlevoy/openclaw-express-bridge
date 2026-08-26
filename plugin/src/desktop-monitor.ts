/** Inbound monitor for one official eXpress desktop session via loopback CDP. */

import { homedir } from "node:os";
import { extname, join } from "node:path";

import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";
import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

import { resolveExpressDesktopChats } from "./accounts.js";
import {
  type DesktopAckHandle,
  withDesktopInboundAcknowledgement,
} from "./desktop-ack.js";
import {
  DEFAULT_DESKTOP_MEDIA_MAX_MB,
  DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
  type DesktopChatListDigest,
  desktopClientFromAccount,
  DesktopDedupeStore,
  type DesktopMessage,
  isDesktopOutboundUnlocked,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";
import {
  desktopDeliveryEntryNeedsReconciliation,
  loadDesktopDeliveryJournal,
} from "./desktop-delivery-journal.js";
import {
  type DesktopCachedReply,
  DesktopFinalReplyCache,
} from "./desktop-reply-cache.js";
import { desktopReplySender, desktopRoutePeer } from "./desktop-routing.js";
import {
  DesktopDispatchRateLimiter,
  redactDesktopError,
  selectDesktopInboundBatchResilient,
} from "./desktop-safety.js";
import {
  DesktopDispatchScheduler,
  DesktopRoundRobin,
} from "./desktop-scheduler.js";
import { DesktopDeliveryWatchdog } from "./desktop-watchdog.js";
import { toPlainText } from "./format.js";
import type { ExpressMonitorOptions } from "./monitor.js";
import { getExpressRuntime } from "./runtime.js";
import type { DesktopChatConfig } from "./types.js";

export const DESKTOP_INBOUND_EVENT_MAX_ATTEMPTS = 3;
export const MIN_DESKTOP_CHAT_SWITCH_INTERVAL_MS = 1_000;
const DEFAULT_DESKTOP_DISPATCH_CONCURRENCY = 2;
/**
 * Even when the chat list reports no change, open every chat this often. It
 * bounds the damage if the client ever stops refreshing a list entry.
 */
export const DEFAULT_DESKTOP_FULL_SWEEP_INTERVAL_MS = 300_000;

export class DesktopInboundReplyDeliveryError extends Error {
  constructor(readonly detail: string) {
    super("desktop inbound reply was not visibly delivered");
    this.name = "DesktopInboundReplyDeliveryError";
  }
}

export function isDesktopComposerBlockedDelivery(
  error: unknown,
): error is DesktopInboundReplyDeliveryError {
  return (
    error instanceof DesktopInboundReplyDeliveryError &&
    error.detail === "desktop eXpress composer has pending attachments"
  );
}

export class DesktopReplyDeliveryTracker {
  private finalVisible = false;

  observe(kind: string, result: { visibleReplySent?: boolean } | void): void {
    if (kind === "final" && result?.visibleReplySent !== false) {
      this.finalVisible = true;
    }
  }

  assertFinalVisible(required: boolean): void {
    if (!required || this.finalVisible) return;
    throw new DesktopInboundReplyDeliveryError(
      "dispatcher settled without a confirmed visible final",
    );
  }
}

export function validateDesktopExactPeerRoutes(
  config: ExpressMonitorOptions["config"],
  accountId: string,
  chats: DesktopChatConfig[],
): ResolvedAgentRoute[] {
  const routes = chats.map((chat) =>
    resolveAgentRoute({
      cfg: config,
      channel: "express",
      accountId,
      peer: desktopRoutePeer(chat),
    }),
  );
  for (const [index, route] of routes.entries()) {
    if (route.matchedBy !== "binding.peer") {
      throw new Error(
        `eXpress desktop chat ${index + 1} requires an exact direct peer binding; resolved by ${route.matchedBy}`,
      );
    }
  }
  if (new Set(routes.map((route) => route.sessionKey)).size !== routes.length) {
    throw new Error(
      "eXpress desktop chats must resolve to separate per-peer session keys",
    );
  }
  return routes;
}

export function createDesktopSourceReplyOptions(
  onModelSelected: ReturnType<
    typeof createReplyPrefixOptions
  >["onModelSelected"],
) {
  return {
    onModelSelected,
    // Desktop inbound owns a verified delivery callback. Keep ordinary model
    // finals on that path instead of requiring the agent to call `message`.
    sourceReplyDeliveryMode: "automatic" as const,
  };
}

export function desktopPollSliceMs(
  pollIntervalMs: number,
  chatCount: number,
): number {
  if (chatCount <= 1) return pollIntervalMs;
  return Math.max(
    MIN_DESKTOP_CHAT_SWITCH_INTERVAL_MS,
    Math.floor(pollIntervalMs / chatCount),
  );
}

export function resolveDesktopDurableTextDelivery(
  chatId: string,
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  },
  kind: string,
) {
  if (kind !== "final" || !payload.text?.trim()) return false;
  const media = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (media.length > 0) return false;
  return {
    to: `express:${chatId}`,
    requiredCapabilities: {
      text: true as const,
      reconcileUnknownSend: true as const,
    },
  };
}

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

interface PreparedDesktopInbound {
  text: string;
  attachmentText: string;
  mediaPaths: string[];
  mediaTypes: string[];
}

interface DesktopChatRuntime {
  chat: DesktopChatConfig;
  store: DesktopDedupeStore;
  needsBaseline: boolean;
  pendingIds: Set<string>;
  /** Last chat-list activity marker this chat was reconciled against. */
  lastEventSyncId?: string | null;
  /** When this chat was last opened and read in full. */
  lastFullCheckAt: number;
}

/**
 * Decide which chats actually need the expensive exact navigation.
 *
 * Opening a chat re-renders the official client, so it must happen only when
 * something changed. A chat the digest does not describe is treated as
 * unknown and checked, never as quiet: missing a message is far worse than
 * one redundant navigation.
 */
export function selectDesktopDueChats<
  T extends {
    chat: { chatId: string };
    needsBaseline: boolean;
    lastEventSyncId?: string | null;
    lastFullCheckAt: number;
  },
>(params: {
  runtimes: readonly T[];
  digest: DesktopChatListDigest;
  now: number;
  fullSweepIntervalMs: number;
}): T[] {
  const byChatId = new Map(
    params.digest.entries.map((entry) => [entry.chatId.toLowerCase(), entry]),
  );
  return params.runtimes.filter((runtime) => {
    if (runtime.needsBaseline) return true;
    if (params.now - runtime.lastFullCheckAt >= params.fullSweepIntervalMs) {
      return true;
    }
    const entry = byChatId.get(runtime.chat.chatId.toLowerCase());
    if (!entry) return true;
    if (entry.unreadCounter > 0 || entry.mentionCounter > 0) return true;
    return entry.lastEventSyncId !== runtime.lastEventSyncId;
  });
}

export class DesktopActiveSessionRegistry {
  private readonly active = new Map<string, number>();
  private abortPromise?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly abortSession: (sessionKey: string) => Promise<void>,
  ) {}

  async run<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      throw new Error("eXpress desktop monitor stopped");
    }
    this.active.set(sessionKey, (this.active.get(sessionKey) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const remaining = (this.active.get(sessionKey) ?? 1) - 1;
      if (remaining > 0) this.active.set(sessionKey, remaining);
      else this.active.delete(sessionKey);
    }
  }

  async abortAll(): Promise<void> {
    this.stopping = true;
    this.abortPromise ??= Promise.allSettled(
      [...this.active.keys()].map((sessionKey) =>
        this.abortSession(sessionKey),
      ),
    ).then(() => undefined);
    await this.abortPromise;
  }
}

export function isDesktopPriorityAbortMessage(
  message: DesktopMessage,
): boolean {
  return (
    message.type === "text" &&
    !message.attachment &&
    isAbortRequestText(message.text)
  );
}

/**
 * Chat commands are answered by the command layer through the durable
 * outbound queue, so the turn itself queues no reply payload and the
 * dispatcher never reports a visible final. Demanding one marked delivered
 * command output as failed and re-ran the inbound event, which executed the
 * command again and posted the same answer twice.
 */
export function isDesktopChatCommandMessage(message: DesktopMessage): boolean {
  return (
    message.type === "text" &&
    !message.attachment &&
    /^\/[A-Za-z][\w-]*(\s|$)/.test((message.text ?? "").trim())
  );
}

/**
 * Isolate a poison attachment from the CDP connection. Attachment failures
 * receive a bounded durable retry and then only that message id is skipped.
 * Transport or OpenClaw dispatch failures remain retryable.
 */
export async function processDesktopInboundEvent(
  options: ProcessDesktopInboundEventOptions,
): Promise<DesktopInboundEventOutcome> {
  try {
    await options.work();
    await options.store.add(options.message.id);
    return "delivered";
  } catch (error) {
    // A human draft or an attachment left by an earlier bridge build can keep
    // the official composer occupied. This is a transient delivery interlock,
    // not a poison inbound event: consuming the three-attempt budget here
    // quarantined a perfectly valid user message in under two seconds.
    if (isDesktopComposerBlockedDelivery(error)) {
      await options.store.releaseInboundClaim(options.message.id);
      options.onDiagnostic?.("retry", 0, error.detail);
      return "retry";
    }
    if (
      !(error instanceof DesktopInboundAttachmentError) &&
      !(error instanceof DesktopInboundReplyDeliveryError)
    ) {
      throw error;
    }
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
    message === "active desktop chat title is not allowlisted" ||
    message === "desktop allowlisted chat was not found" ||
    message === "desktop allowlisted chat UUID could not be routed" ||
    message ===
      "official eXpress desktop renderer did not recover after reload" ||
    message === "desktop active chat did not match the allowlisted target"
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

function assertDesktopMonitorActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("eXpress desktop monitor stopped");
  }
}

export function desktopStatePathForChat(
  configuredPath: string | undefined,
  accountId: string,
  chatId: string,
  multiChat: boolean,
): string {
  if (!multiChat) {
    return (
      configuredPath ??
      join(homedir(), ".openclaw", "express-desktop", `${accountId}.json`)
    );
  }
  if (!configuredPath) {
    return join(
      homedir(),
      ".openclaw",
      "express-desktop",
      accountId,
      `${chatId}.json`,
    );
  }
  const extension = extname(configuredPath) || ".json";
  const stem = configuredPath.endsWith(extension)
    ? configuredPath.slice(0, -extension.length)
    : configuredPath;
  return `${stem}.${chatId}${extension}`;
}

export function validateDesktopExactAllowlist(
  chats: readonly DesktopChatConfig[],
  allowFrom: readonly string[],
): void {
  const expected = new Set(
    chats.flatMap((chat) => [
      chat.chatId.toLowerCase(),
      chat.senderId.toLowerCase(),
    ]),
  );
  const actual = new Set(
    allowFrom.map((entry) =>
      String(entry)
        .replace(/^express:/i, "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (
    actual.has("*") ||
    actual.size !== expected.size ||
    [...expected].some((id) => !actual.has(id))
  ) {
    throw new Error(
      "eXpress desktop allowFrom must exactly match configured chat and sender UUIDs",
    );
  }
}

export async function startExpressDesktopMonitor(
  opts: ExpressMonitorOptions,
): Promise<void> {
  const { account, abortSignal, log, statusSink } = opts;
  if (!account.configured || account.mode !== "desktop") {
    throw new Error("eXpress desktop account is not fully configured");
  }

  const chats = resolveExpressDesktopChats(account);
  if (!chats.length) {
    throw new Error("eXpress desktop allowlist is incomplete");
  }
  if ((account.config.dmPolicy ?? "pairing") !== "allowlist") {
    throw new Error("eXpress desktop bridge requires dmPolicy=allowlist");
  }
  validateDesktopExactAllowlist(chats, account.config.allowFrom ?? []);
  const routes = validateDesktopExactPeerRoutes(
    opts.config,
    account.accountId,
    chats,
  );

  const chatRuntimes: DesktopChatRuntime[] = [];
  for (const chat of chats) {
    const store = new DesktopDedupeStore(
      desktopStatePathForChat(
        account.config.desktopStatePath,
        account.accountId,
        chat.chatId,
        chats.length > 1,
      ),
    );
    const stateExisted = await store.load();
    chatRuntimes.push({
      chat,
      store,
      needsBaseline: !stateExisted,
      pendingIds: new Set(),
      lastFullCheckAt: 0,
    });
  }

  const deliveryWatchdog = new DesktopDeliveryWatchdog();
  let watchdogLastError: string | null = null;
  let watchdogFingerprint = "";
  let watchdogAuditPromise: Promise<void> | null = null;
  const auditWatchdog = async () => {
    const [journal, ...dedupe] = await Promise.all([
      loadDesktopDeliveryJournal(account),
      ...chatRuntimes.map((runtime) => runtime.store.healthSnapshot()),
    ]);
    const issues = deliveryWatchdog.audit({
      dedupe,
      journalEntries: Object.values(journal?.entries ?? {}).map((entry) => ({
        updatedAt: entry.updatedAt,
        unresolved: desktopDeliveryEntryNeedsReconciliation(entry),
      })),
    });
    const fingerprint = issues.join("; ");
    watchdogLastError = issues.length
      ? `eXpress delivery watchdog: ${fingerprint}`
      : null;
    if (fingerprint === watchdogFingerprint) return;
    if (issues.length > 0) {
      log?.warn?.(`[${account.accountId}] ${watchdogLastError}`);
      statusSink?.({ lastError: watchdogLastError });
    } else if (watchdogFingerprint) {
      log?.info?.(`[${account.accountId}] eXpress delivery watchdog healthy`);
    }
    watchdogFingerprint = fingerprint;
  };
  const requestWatchdogAudit = () => {
    if (watchdogAuditPromise) return;
    watchdogAuditPromise = auditWatchdog()
      .catch((error) => {
        log?.warn?.(
          `[${account.accountId}] eXpress delivery watchdog audit failed: ${redactDesktopError(error)}`,
        );
      })
      .finally(() => {
        watchdogAuditPromise = null;
      });
  };
  await auditWatchdog();
  const watchdogTimer = setInterval(requestWatchdogAudit, 30_000);
  watchdogTimer.unref();

  const pollIntervalMs = account.config.desktopPollIntervalMs ?? 1000;
  const pollSliceMs = desktopPollSliceMs(pollIntervalMs, chatRuntimes.length);
  const client = desktopClientFromAccount(account);
  const rateLimiter = new DesktopDispatchRateLimiter();
  const activeSessions = new DesktopActiveSessionRegistry(
    async (sessionKey) => {
      const gateway = getExpressRuntime().gateway;
      if (!(await gateway.isAvailable())) return;
      await gateway.request(
        "chat.abort",
        { sessionKey, preserveSideRuns: true },
        { timeoutMs: 5_000 },
      );
    },
  );
  const abortActiveSessions = () => {
    void activeSessions.abortAll().catch((error) => {
      log?.warn?.(
        `[${account.accountId}] eXpress desktop active-run abort failed: ${redactDesktopError(error)}`,
      );
    });
  };
  abortSignal.addEventListener("abort", abortActiveSessions, { once: true });
  const scheduler = new DesktopDispatchScheduler({
    concurrency:
      account.config.desktopDispatchConcurrency ??
      DEFAULT_DESKTOP_DISPATCH_CONCURRENCY,
    onError: (chatId, error) => {
      const message = redactDesktopError(error);
      statusSink?.({ lastError: message });
      log?.error?.(
        `[${account.accountId}] eXpress desktop dispatch failed chat=${chatId}: ${message}`,
      );
      if (isDesktopTransportFailure(error)) {
        void client.withUiLock(async () => client.close());
      }
    },
  });
  const roundRobin = new DesktopRoundRobin(chatRuntimes);
  const replyCache = new DesktopFinalReplyCache();
  const fullSweepIntervalMs =
    account.config.desktopFullSweepIntervalMs ??
    DEFAULT_DESKTOP_FULL_SWEEP_INTERVAL_MS;
  let digestSupported = true;
  let reconnectDelayMs = 1000;

  statusSink?.({
    running: true,
    lastStartAt: Date.now(),
    lastError: watchdogLastError,
  });
  log?.info?.(
    `[${account.accountId}] eXpress desktop bridge started (${chats.length} exact chat allowlist entries, exact peer routes to ${[...new Set(routes.map((route) => route.agentId))].join(",")}, cross-process CDP mutex, dispatch concurrency ${account.config.desktopDispatchConcurrency ?? DEFAULT_DESKTOP_DISPATCH_CONCURRENCY}, idle chat-list watch with a ${Math.floor(fullSweepIntervalMs / 1000)}s full sweep)`,
  );

  try {
    while (!abortSignal.aborted) {
      try {
        const digest = digestSupported ? await client.chatListDigest() : null;
        if (digest?.chatListReady && digest.entries.length === 0) {
          // The list is rendered but describes none of the allowlisted chats:
          // the official client changed its internals. Degrade instead of
          // silently reporting every chat as quiet.
          digestSupported = false;
          log?.warn?.(
            `[${account.accountId}] eXpress desktop chat-list digest is unavailable; falling back to sequential polling`,
          );
        }
        const usableDigest =
          digestSupported && digest?.chatListReady ? digest : null;
        const due = usableDigest
          ? selectDesktopDueChats({
              runtimes: chatRuntimes,
              digest: usableDigest,
              now: Date.now(),
              fullSweepIntervalMs,
            })
          : [roundRobin.next()];
        reconnectDelayMs = 1000;
        statusSink?.({ lastError: watchdogLastError });

        for (const runtime of due) {
          assertDesktopMonitorActive(abortSignal);
          const snapshot = await client.snapshotAllowed(runtime.chat.chatId);
          client.assertSnapshotAllowed(snapshot, runtime.chat.chatId);
          runtime.lastFullCheckAt = Date.now();
          // Record the marker observed before this read: anything that arrives
          // while the chat is open keeps the chat due for one more pass.
          runtime.lastEventSyncId =
            usableDigest?.entries.find(
              (entry) => entry.chatId === runtime.chat.chatId.toLowerCase(),
            )?.lastEventSyncId ?? null;

          if (runtime.needsBaseline) {
            await runtime.store.baseline(
              snapshot.messages.map((message) => message.id),
            );
            runtime.needsBaseline = false;
            log?.info?.(
              `[${account.accountId}] eXpress desktop baseline recorded chat=${runtime.chat.chatId} (${snapshot.messages.length} visible inbound ids)`,
            );
          } else {
            await queueSnapshotMessages(opts, {
              runtime,
              snapshotMessages: snapshot.messages,
              scheduler,
              client,
              rateLimiter,
              activeSessions,
              deliveryWatchdog,
              replyCache,
            });
          }
        }
        await sleepWithAbort(
          usableDigest ? pollIntervalMs : pollSliceMs,
          abortSignal,
        );
      } catch (error) {
        await client.withUiLock(async () => client.close());
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
    clearInterval(watchdogTimer);
    await watchdogAuditPromise;
    abortSignal.removeEventListener("abort", abortActiveSessions);
    await activeSessions.abortAll();
    await client.withUiLock(async () => client.close());
    statusSink?.({ running: false, lastStopAt: Date.now() });
    log?.info?.(`[${account.accountId}] eXpress desktop bridge stopped`);
  }
}

async function queueSnapshotMessages(
  opts: ExpressMonitorOptions,
  params: {
    runtime: DesktopChatRuntime;
    snapshotMessages: DesktopMessage[];
    scheduler: DesktopDispatchScheduler;
    client: ReturnType<typeof desktopClientFromAccount>;
    rateLimiter: DesktopDispatchRateLimiter;
    activeSessions: DesktopActiveSessionRegistry;
    deliveryWatchdog: DesktopDeliveryWatchdog;
    replyCache: DesktopFinalReplyCache;
  },
): Promise<void> {
  const { account, abortSignal, log, statusSink } = opts;
  const {
    runtime,
    scheduler,
    client,
    rateLimiter,
    activeSessions,
    deliveryWatchdog,
    replyCache,
  } = params;
  const { chat, store, pendingIds } = runtime;
  const maxMediaBytes = Math.floor(
    (account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB) * 1024 * 1024,
  );
  const watchdogKey = (messageId: string) => `${chat.chatId}:${messageId}`;
  const batch = selectDesktopInboundBatchResilient(
    params.snapshotMessages,
    (messageId) => store.has(messageId) || pendingIds.has(messageId),
    {
      expectedSenderId: chat.senderId,
      maxMediaBytes,
    },
  );
  const onDiagnostic = (
    message: DesktopMessage,
    outcome: Exclude<DesktopInboundEventOutcome, "delivered">,
    attempt: number,
    diagnostic: string,
  ) =>
    log?.warn?.(
      `[${account.accountId}] eXpress desktop inbound ${outcome} chat=${chat.chatId} id=${message.id} type=${message.type} attempt=${attempt}/${DESKTOP_INBOUND_EVENT_MAX_ATTEMPTS}: ${diagnostic}`,
    );

  for (const rejected of batch.rejected) {
    if (pendingIds.has(rejected.message.id)) continue;
    pendingIds.add(rejected.message.id);
    let claimed = false;
    try {
      claimed = await store.claimInbound(rejected.message.id);
    } catch (error) {
      pendingIds.delete(rejected.message.id);
      throw error;
    }
    if (!claimed) {
      pendingIds.delete(rejected.message.id);
      continue;
    }
    deliveryWatchdog.begin(watchdogKey(rejected.message.id));
    const accepted = scheduler.enqueue(chat.chatId, async () => {
      try {
        if (abortSignal.aborted) {
          await store.releaseInboundClaim(rejected.message.id);
          return;
        }
        await processDesktopInboundEvent({
          message: rejected.message,
          store,
          work: async () => {
            throw new DesktopInboundAttachmentError(rejected.error);
          },
          onDiagnostic: (outcome, attempt, diagnostic) =>
            onDiagnostic(rejected.message, outcome, attempt, diagnostic),
        });
      } finally {
        pendingIds.delete(rejected.message.id);
        deliveryWatchdog.end(watchdogKey(rejected.message.id));
      }
    });
    if (!accepted) {
      pendingIds.delete(rejected.message.id);
      deliveryWatchdog.end(watchdogKey(rejected.message.id));
      await store.releaseInboundClaim(rejected.message.id);
    }
  }

  for (const message of batch.queued) {
    pendingIds.add(message.id);
    let claimed = false;
    try {
      claimed = await store.claimInbound(message.id);
    } catch (error) {
      pendingIds.delete(message.id);
      throw error;
    }
    if (!claimed) {
      pendingIds.delete(message.id);
      continue;
    }
    deliveryWatchdog.begin(watchdogKey(message.id));

    if (isDesktopPriorityAbortMessage(message)) {
      const accepted = scheduler.runPriority(chat.chatId, async () => {
        try {
          if (abortSignal.aborted) {
            await store.releaseInboundClaim(message.id);
            return;
          }
          await processDesktopInboundEvent({
            message,
            store,
            work: async () => {
              assertDesktopMonitorActive(abortSignal);
              const prepared = await prepareDesktopInbound(
                opts,
                chat,
                message,
                client,
                maxMediaBytes,
              );
              await dispatchDesktopInbound(
                opts,
                chat,
                message,
                prepared,
                client,
                undefined,
                activeSessions,
              );
            },
            onDiagnostic: (outcome, attempt, diagnostic) =>
              onDiagnostic(message, outcome, attempt, diagnostic),
          });
        } catch (error) {
          await store.releaseInboundClaim(message.id);
          throw error;
        } finally {
          pendingIds.delete(message.id);
          deliveryWatchdog.end(watchdogKey(message.id));
        }
      });
      if (!accepted) {
        pendingIds.delete(message.id);
        deliveryWatchdog.end(watchdogKey(message.id));
        await store.releaseInboundClaim(message.id);
        log?.warn?.(
          `[${account.accountId}] eXpress desktop priority queue full chat=${chat.chatId}`,
        );
      }
      continue;
    }

    const accepted = scheduler.enqueue(chat.chatId, async () => {
      try {
        if (abortSignal.aborted) {
          await store.releaseInboundClaim(message.id);
          return;
        }
        await withDesktopInboundAcknowledgement(
          {
            account,
            client,
            targetChatId: chat.chatId,
            claim: () => store.claimAcknowledgement(message.id),
            onActivity: () => statusSink?.({ lastOutboundAt: Date.now() }),
            onError: (kind, error) =>
              log?.warn?.(
                `[${account.accountId}] eXpress desktop ${kind} acknowledgement unavailable chat=${chat.chatId}: ${redactDesktopError(error)}`,
              ),
          },
          async (acknowledgement) => {
            await sleepWithAbort(rateLimiter.reserve(), abortSignal);
            if (abortSignal.aborted) return;
            await processDesktopInboundEvent({
              message,
              store,
              work: async () => {
                assertDesktopMonitorActive(abortSignal);
                const cached = replyCache.get(message.id);
                if (cached) {
                  // The turn already ran; only its delivery failed.
                  await acknowledgement?.stop();
                  log?.info?.(
                    `[${account.accountId}] eXpress desktop redelivering cached final chat=${chat.chatId} id=${message.id}`,
                  );
                  await redeliverDesktopCachedFinal({
                    opts,
                    chat,
                    client,
                    cached,
                  });
                  replyCache.clear(message.id);
                  return;
                }
                const prepared = await prepareDesktopInbound(
                  opts,
                  chat,
                  message,
                  client,
                  maxMediaBytes,
                );
                await dispatchDesktopInbound(
                  opts,
                  chat,
                  message,
                  prepared,
                  client,
                  acknowledgement,
                  activeSessions,
                  replyCache,
                );
                replyCache.clear(message.id);
                assertDesktopMonitorActive(abortSignal);
              },
              onDiagnostic: (outcome, attempt, diagnostic) =>
                onDiagnostic(message, outcome, attempt, diagnostic),
            });
          },
        );
      } catch (error) {
        // Keep the claim while dispatch is active so a reload cannot start a
        // duplicate turn. Once dispatch has definitively failed, release it so
        // a later poll can retry instead of suppressing the message forever.
        await store.releaseInboundClaim(message.id);
        throw error;
      } finally {
        pendingIds.delete(message.id);
        deliveryWatchdog.end(watchdogKey(message.id));
      }
    });
    if (!accepted) {
      pendingIds.delete(message.id);
      deliveryWatchdog.end(watchdogKey(message.id));
      await store.releaseInboundClaim(message.id);
      log?.warn?.(
        `[${account.accountId}] eXpress desktop per-chat queue full chat=${chat.chatId}`,
      );
    }
  }
}

function toCachedReply(payload: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): DesktopCachedReply {
  const mediaUrls = normalizeDesktopMediaUrls(payload);
  return { text: payload.text, mediaUrls };
}

export function normalizeDesktopMediaUrls(payload: {
  mediaUrl?: string;
  mediaUrls?: string[];
}): string[] | undefined {
  const unique = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ]
    .map((value) => value.trim())
    .filter(
      (value, index, values) =>
        Boolean(value) && values.indexOf(value) === index,
    );
  return unique.length ? unique : undefined;
}

/**
 * Send one reply payload under a single UI lease.
 *
 * Taking the lease per fragment let the poll loop switch chats between the
 * chunks of one answer, which forced the client to navigate back and forth.
 * Both interlocks are still re-checked before every individual send.
 */
async function deliverDesktopPayload(params: {
  opts: ExpressMonitorOptions;
  chat: DesktopChatConfig;
  client: ReturnType<typeof desktopClientFromAccount>;
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
}): Promise<void> {
  const { opts, chat, client, payload } = params;
  const { account, abortSignal, statusSink } = opts;
  const core = getExpressRuntime();
  const replySender = desktopReplySender(chat, client);
  const chunks = payload.text?.trim()
    ? core.channel.text.chunkText(
        toPlainText(payload.text).trim(),
        Math.min(
          account.config.textChunkLimit ?? DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
          DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
        ),
      )
    : [];
  const media = normalizeDesktopMediaUrls(payload) ?? [];
  if (!chunks.length && !media.length) return;

  await client.withUiLock(async () => {
    for (const chunk of chunks) {
      assertDesktopMonitorActive(abortSignal);
      if (!(await isDesktopOutboundUnlocked(account))) {
        throw new Error("desktop eXpress outbound was locked during reply");
      }
      await replySender.sendText(chunk);
      statusSink?.({ lastOutboundAt: Date.now() });
    }
    for (const mediaUrl of media) {
      assertDesktopMonitorActive(abortSignal);
      if (!(await isDesktopOutboundUnlocked(account))) {
        throw new Error("desktop eXpress outbound was locked during reply");
      }
      const file = await validateDesktopOutboundFile(
        mediaUrl,
        account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB,
        account.config.desktopMediaRoots,
      );
      assertDesktopMonitorActive(abortSignal);
      if (!(await isDesktopOutboundUnlocked(account))) {
        throw new Error(
          "desktop eXpress outbound was locked during file validation",
        );
      }
      await replySender.sendFile(file);
      statusSink?.({ lastOutboundAt: Date.now() });
    }
  });
}

/**
 * Re-send a final that was already generated. Transport faults keep their
 * own identity so the monitor can still reconnect; anything else counts as
 * another invisible delivery, which advances the bounded retry.
 */
async function redeliverDesktopCachedFinal(params: {
  opts: ExpressMonitorOptions;
  chat: DesktopChatConfig;
  client: ReturnType<typeof desktopClientFromAccount>;
  cached: DesktopCachedReply;
}): Promise<void> {
  const { opts, chat, client, cached } = params;
  if (!(await isDesktopOutboundUnlocked(opts.account))) {
    opts.log?.info?.(
      `[${opts.account.accountId}] eXpress desktop cached reply withheld by outbound interlock`,
    );
    return;
  }
  try {
    await deliverDesktopPayload({
      opts,
      chat,
      client,
      payload: { text: cached.text, mediaUrls: cached.mediaUrls },
    });
  } catch (error) {
    if (isDesktopTransportFailure(error)) throw error;
    throw new DesktopInboundReplyDeliveryError(redactDesktopError(error));
  }
}

async function prepareDesktopInbound(
  opts: ExpressMonitorOptions,
  chat: DesktopChatConfig,
  message: DesktopMessage,
  client: ReturnType<typeof desktopClientFromAccount>,
  maxMediaBytes: number,
): Promise<PreparedDesktopInbound> {
  const text = message.text.trim();
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  let attachmentText = "";
  if (message.attachment) {
    try {
      // The client holds the shared CDP mutex only while verifying and reading
      // the exact chat. Saving the buffer happens after that lock is released.
      const downloaded = await client.downloadAttachment(
        message,
        maxMediaBytes,
        chat.chatId,
      );
      const saved = await getExpressRuntime().channel.media.saveMediaBuffer(
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
  return { text, attachmentText, mediaPaths, mediaTypes };
}

async function dispatchDesktopInbound(
  opts: ExpressMonitorOptions,
  chat: DesktopChatConfig,
  message: DesktopMessage,
  prepared: PreparedDesktopInbound,
  client: ReturnType<typeof desktopClientFromAccount>,
  acknowledgement?: DesktopAckHandle,
  activeSessions?: DesktopActiveSessionRegistry,
  replyCache?: DesktopFinalReplyCache,
): Promise<void> {
  const { account, abortSignal, config, log, statusSink } = opts;
  const { text, attachmentText, mediaPaths, mediaTypes } = prepared;
  assertDesktopMonitorActive(abortSignal);
  if (!text && mediaPaths.length === 0) return;

  statusSink?.({ lastInboundAt: Date.now() });
  log?.info?.(
    `[${account.accountId}] eXpress desktop inbound chat=${chat.chatId} id=${message.id}`,
  );

  const core = getExpressRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "express",
    accountId: account.accountId,
    peer: desktopRoutePeer(chat),
  });
  const senderName = chat.senderName ?? chat.chatTitle;
  const fromLabel = senderName
    ? `${senderName} (${chat.senderId})`
    : `user:${chat.senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    config.session?.store,
    { agentId: route.agentId },
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
    From: `express:${chat.senderId}`,
    To: `express:${chat.chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: chat.senderId,
    Provider: "express",
    Surface: "express",
    MessageSid: message.id,
    MessageSidFull: message.id,
    // Startup validated this exact chat and sender allowlist. Preserve that
    // authorization so a priority stop reaches OpenClaw's fast-abort path.
    CommandAuthorized: true,
    OriginatingChannel: "express",
    OriginatingTo: `express:${chat.chatId}`,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length ? mediaPaths : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length ? mediaTypes : undefined,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "express",
    accountId: route.accountId,
  });
  const deliveryTracker = new DesktopReplyDeliveryTracker();

  const dispatch = async () => {
    const result = await core.channel.inbound.dispatchReply({
      cfg: config,
      channel: "express",
      accountId: account.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      messageId: message.id,
      storePath,
      ctxPayload,
      recordInboundSession: core.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        durable: async (payload, info) => {
          const durableDelivery = resolveDesktopDurableTextDelivery(
            chat.chatId,
            payload,
            info.kind,
          );
          if (!durableDelivery) return false;
          await acknowledgement?.stop();
          assertDesktopMonitorActive(abortSignal);
          if (!(await isDesktopOutboundUnlocked(account))) return false;
          return durableDelivery;
        },
        deliver: async (
          payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          },
          info?: { kind?: string },
        ) => {
          await acknowledgement?.stop();
          assertDesktopMonitorActive(abortSignal);
          if (!(await isDesktopOutboundUnlocked(account))) {
            log?.info?.(
              `[${account.accountId}] eXpress desktop reply withheld by outbound interlock`,
            );
            return;
          }
          // The model has already produced this final and the tokens are
          // spent. Remember it before the first attempt so a transport-only
          // failure re-sends the text instead of re-running the turn.
          if (info?.kind === "final") {
            replyCache?.remember(message.id, toCachedReply(payload));
          }
          await deliverDesktopPayload({ opts, chat, client, payload });
        },
        onDelivered: (_payload, _info, result) => {
          deliveryTracker.observe(_info.kind, result);
          if (result?.visibleReplySent !== false) {
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        },
        onError: (error, info) => {
          log?.error?.(
            `[${account.accountId}] ${info.kind} desktop reply failed chat=${chat.chatId}: ${redactDesktopError(error)}`,
          );
        },
      },
      replyPipeline: {},
      dispatcherOptions: prefixOptions,
      replyOptions: createDesktopSourceReplyOptions(onModelSelected),
      record: {
        onRecordError: (error) => {
          log?.error?.(
            `[${account.accountId}] Failed updating desktop session meta: ${redactDesktopError(error)}`,
          );
        },
      },
    });
    deliveryTracker.assertFinalVisible(
      !isDesktopPriorityAbortMessage(message) &&
        !isDesktopChatCommandMessage(message),
    );
    return result;
  };
  if (activeSessions) {
    await activeSessions.run(route.sessionKey, dispatch);
  } else {
    await dispatch();
  }
}
