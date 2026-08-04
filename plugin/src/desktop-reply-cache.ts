/**
 * Short-lived cache of already-generated final replies.
 *
 * A final that the official client failed to confirm is a transport problem,
 * not a generation problem: the model has already produced the answer and the
 * tokens are already spent. Retrying the inbound event would run the whole
 * turn again, so the finished payload is kept here and re-delivered instead.
 *
 * The cache is deliberately in-memory and short-lived. It covers the retry
 * that follows within seconds; anything longer is handled by the durable
 * delivery journal, and nothing here is written to disk.
 */

export interface DesktopCachedReply {
  text?: string;
  mediaUrls?: string[];
}

export const DEFAULT_DESKTOP_REPLY_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_DESKTOP_REPLY_CACHE_MAX_ENTRIES = 64;

interface CacheEntry {
  reply: DesktopCachedReply;
  storedAt: number;
}

export class DesktopFinalReplyCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_DESKTOP_REPLY_CACHE_TTL_MS,
    private readonly maxEntries = DEFAULT_DESKTOP_REPLY_CACHE_MAX_ENTRIES,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error("desktop reply cache ttl is invalid");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("desktop reply cache capacity is invalid");
    }
  }

  /** Record a final payload before its first delivery attempt. */
  remember(
    messageId: string,
    reply: DesktopCachedReply,
    now = Date.now(),
  ): void {
    const text = reply.text?.trim();
    const mediaUrls = reply.mediaUrls?.filter(Boolean);
    if (!text && !mediaUrls?.length) return;
    this.entries.delete(messageId);
    this.entries.set(messageId, {
      reply: {
        text,
        mediaUrls: mediaUrls?.length ? [...mediaUrls] : undefined,
      },
      storedAt: now,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  /** Return a still-fresh payload, dropping it if it has expired. */
  get(messageId: string, now = Date.now()): DesktopCachedReply | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    if (now - entry.storedAt >= this.ttlMs) {
      this.entries.delete(messageId);
      return undefined;
    }
    return entry.reply;
  }

  clear(messageId: string): void {
    this.entries.delete(messageId);
  }

  get size(): number {
    return this.entries.size;
  }
}
