import type { DesktopMessage } from "./desktop-cdp.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;

export const DESKTOP_MAX_PENDING_MESSAGES = 32;
export const DESKTOP_MAX_INBOUND_TEXT_LENGTH = 32_768;
export const DESKTOP_MIN_DISPATCH_INTERVAL_MS = 500;

export interface DesktopInboundSafetyLimits {
  expectedSenderId: string;
  maxMediaBytes: number;
}

function normalizeDesktopAttachment(message: DesktopMessage) {
  const attachment = message.attachment;
  if (message.type === "text" || !attachment) {
    throw new Error("desktop inbound attachment metadata is missing");
  }
  if (!UUID_PATTERN.test(attachment.fileId)) {
    throw new Error("desktop inbound attachment id is invalid");
  }
  const fileName = attachment.fileName.trim();
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.length > 255 ||
    /[\0-\x1f\x7f/\\]/.test(fileName)
  ) {
    throw new Error("desktop inbound attachment name is unsafe");
  }
  if (!Number.isSafeInteger(attachment.fileSize) || attachment.fileSize < 1) {
    throw new Error("desktop inbound attachment size is invalid");
  }
  const mimeType = attachment.mimeType.trim().toLowerCase();
  if (
    mimeType.length > 255 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
  ) {
    throw new Error("desktop inbound attachment MIME type is invalid");
  }
  const expectedKind =
    message.type === "image"
      ? "image"
      : message.type === "audio" || message.type === "voice"
        ? "audio"
        : message.type === "video"
          ? "video"
          : "file";
  if (attachment.kind !== expectedKind) {
    throw new Error("desktop inbound attachment kind is inconsistent");
  }
  return { ...attachment, fileName, mimeType };
}

/**
 * Build one bounded, deterministic inbound batch. Rejecting the complete
 * batch on malformed or excessive input keeps the bridge fail-closed.
 */
export function selectDesktopInboundBatch(
  messages: DesktopMessage[],
  alreadySeen: (id: string) => boolean,
  limits: DesktopInboundSafetyLimits,
  maxPending = DESKTOP_MAX_PENDING_MESSAGES,
): DesktopMessage[] {
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new Error("desktop inbound queue limit is invalid");
  }
  if (!UUID_PATTERN.test(limits.expectedSenderId)) {
    throw new Error("desktop inbound sender allowlist is invalid");
  }
  if (!Number.isSafeInteger(limits.maxMediaBytes) || limits.maxMediaBytes < 1) {
    throw new Error("desktop inbound media limit is invalid");
  }

  const queuedIds = new Set<string>();
  const queued: DesktopMessage[] = [];
  for (const message of messages) {
    if (!UUID_PATTERN.test(message.id)) {
      throw new Error("desktop inbound message id is invalid");
    }
    if (
      !UUID_PATTERN.test(message.senderId) ||
      message.senderId !== limits.expectedSenderId
    ) {
      throw new Error("desktop inbound sender is not allowlisted");
    }
    if (
      message.type !== "text" &&
      message.type !== "document" &&
      message.type !== "image" &&
      message.type !== "audio" &&
      message.type !== "voice" &&
      message.type !== "video"
    ) {
      throw new Error("desktop inbound message type is unsupported");
    }
    const text = message.text.trim();
    if (text.length > DESKTOP_MAX_INBOUND_TEXT_LENGTH) {
      throw new Error("desktop inbound message exceeds the safety limit");
    }
    const attachment =
      message.type === "text" ? undefined : normalizeDesktopAttachment(message);
    if (message.type === "text" && message.attachment) {
      throw new Error("desktop text message contains an unexpected attachment");
    }
    if (attachment && attachment.fileSize > limits.maxMediaBytes) {
      throw new Error("desktop inbound attachment exceeds the media limit");
    }
    if (!text && !attachment) continue;
    if (alreadySeen(message.id) || queuedIds.has(message.id)) continue;
    queuedIds.add(message.id);
    queued.push({ ...message, text, attachment });
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
    .replace(/(?:blob|file|data):\S+/gi, "[redacted-local-url]")
    .replace(UUID_GLOBAL_PATTERN, "[redacted-id]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}
