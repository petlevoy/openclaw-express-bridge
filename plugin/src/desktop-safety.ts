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

export interface DesktopRejectedInboundEvent {
  message: DesktopMessage;
  error: unknown;
}

export interface DesktopResilientInboundBatch {
  queued: DesktopMessage[];
  rejected: DesktopRejectedInboundEvent[];
}

const DOCUMENT_MIME_BY_EXTENSION: Record<string, ReadonlySet<string>> = {
  ".doc": new Set(["application/msword"]),
  ".docx": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  ".pdf": new Set(["application/pdf"]),
  ".ppt": new Set(["application/vnd.ms-powerpoint"]),
  ".pptx": new Set([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]),
  ".xls": new Set(["application/vnd.ms-excel"]),
  ".xlsx": new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]),
};
const OPENXML_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);
const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);
const VIDEO_EXTENSIONS = new Set([
  ".3g2",
  ".3gp",
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
]);

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

export function isDesktopAttachmentMetadataCompatible(
  messageType: DesktopMessage["type"],
  fileName: string,
  mimeType: string,
): boolean {
  const extension = fileExtension(fileName);
  if (mimeType === "application/octet-stream") {
    if (messageType === "document") {
      return extension in DOCUMENT_MIME_BY_EXTENSION;
    }
    if (messageType === "image") return IMAGE_EXTENSIONS.has(extension);
    if (messageType === "audio" || messageType === "voice") {
      return AUDIO_EXTENSIONS.has(extension);
    }
    if (messageType === "video") return VIDEO_EXTENSIONS.has(extension);
    return false;
  }
  if (messageType === "document") {
    const allowed = DOCUMENT_MIME_BY_EXTENSION[extension];
    return Boolean(
      allowed?.has(mimeType) ||
      (OPENXML_EXTENSIONS.has(extension) &&
        (mimeType === "application/zip" ||
          mimeType === "application/x-zip-compressed")),
    );
  }
  if (messageType === "image") {
    return IMAGE_EXTENSIONS.has(extension) && mimeType.startsWith("image/");
  }
  if (messageType === "audio" || messageType === "voice") {
    return (
      AUDIO_EXTENSIONS.has(extension) &&
      (mimeType.startsWith("audio/") || mimeType === "application/ogg")
    );
  }
  if (messageType === "video") {
    return VIDEO_EXTENSIONS.has(extension) && mimeType.startsWith("video/");
  }
  return false;
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
  if (
    !isDesktopAttachmentMetadataCompatible(message.type, fileName, mimeType)
  ) {
    throw new Error("desktop inbound attachment type is not allowlisted");
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

/**
 * Validate each event independently so one poison attachment cannot reject the
 * remaining visible queue. Invalid bridge limits still fail globally.
 */
export function selectDesktopInboundBatchResilient(
  messages: DesktopMessage[],
  alreadySeen: (id: string) => boolean,
  limits: DesktopInboundSafetyLimits,
  maxPending = DESKTOP_MAX_PENDING_MESSAGES,
): DesktopResilientInboundBatch {
  selectDesktopInboundBatch([], alreadySeen, limits, maxPending);
  const queued: DesktopMessage[] = [];
  const queuedIds = new Set<string>();
  const rejected: DesktopRejectedInboundEvent[] = [];
  for (const message of messages) {
    if (queued.length + rejected.length >= maxPending) break;
    try {
      const selected = selectDesktopInboundBatch(
        [message],
        (id) => alreadySeen(id) || queuedIds.has(id),
        limits,
        1,
      )[0];
      if (!selected) continue;
      queuedIds.add(selected.id);
      queued.push(selected);
    } catch (error) {
      rejected.push({ message, error });
    }
  }
  return { queued, rejected };
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
