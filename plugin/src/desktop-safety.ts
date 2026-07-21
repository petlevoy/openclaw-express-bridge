import type { DesktopMessage } from "./desktop-cdp.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;

export const DESKTOP_MAX_PENDING_MESSAGES = 32;
export const DESKTOP_MAX_INBOUND_TEXT_LENGTH = 32_768;
export const DESKTOP_MIN_DISPATCH_INTERVAL_MS = 500;

/**
 * Build one bounded, deterministic inbound batch. Rejecting the complete
 * batch on malformed or excessive input keeps the bridge fail-closed.
 */
export function selectDesktopInboundBatch(
  messages: DesktopMessage[],
  alreadySeen: (id: string) => boolean,
  maxPending = DESKTOP_MAX_PENDING_MESSAGES,
): DesktopMessage[] {
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new Error("desktop inbound queue limit is invalid");
  }

  const queuedIds = new Set<string>();
  const queued: DesktopMessage[] = [];
  for (const message of messages) {
    if (!UUID_PATTERN.test(message.id)) {
      throw new Error("desktop inbound message id is invalid");
    }
    const text = message.text.trim();
    if (!text) continue;
    if (text.length > DESKTOP_MAX_INBOUND_TEXT_LENGTH) {
      throw new Error("desktop inbound message exceeds the safety limit");
    }
    if (alreadySeen(message.id) || queuedIds.has(message.id)) continue;
    queuedIds.add(message.id);
    queued.push({ id: message.id, text });
    if (queued.length > maxPending) {
      throw new Error("desktop inbound queue capacity exceeded");
    }
  }
  return queued;
}

/** Reserve the next sequential dispatch slot without creating timers. */
export class DesktopDispatchRateLimiter {
  private nextSlotAt = 0;

  constructor(
    private readonly minimumIntervalMs = DESKTOP_MIN_DISPATCH_INTERVAL_MS,
  ) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("desktop dispatch interval is invalid");
    }
  }

  reserve(now = Date.now()): number {
    const slotAt = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slotAt + this.minimumIntervalMs;
    return slotAt - now;
  }
}

/** Keep logs useful without leaking chat ids, endpoints, or message-like text. */
export function redactDesktopError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(UUID_GLOBAL_PATTERN, "[redacted-id]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}
