/**
 * Read/write adapter for the already-authorized official eXpress Electron client.
 *
 * The CDP endpoint must be loopback-only. Reads are restricted to one exact
 * chat UUID and title. Writes additionally require two independent gates:
 * desktopOutboundEnabled=true and the presence of a local switch file.
 */

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedExpressAccount } from "./accounts.js";

interface CdpTarget {
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface CdpDomNode {
  nodeId?: number;
}

interface PendingRequest {
  resolve: (value: CdpReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopMessage {
  id: string;
  senderId: string;
  type: "text" | "document" | "image" | "audio" | "voice" | "video";
  text: string;
  attachment?: DesktopAttachment;
}

export interface DesktopAttachment {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  kind: "file" | "image" | "audio" | "video";
}

export interface DesktopDownloadedAttachment extends DesktopAttachment {
  buffer: Buffer;
}

export interface DesktopSnapshot {
  authenticated: boolean;
  chatId: string | null;
  chatTitle: string | null;
  composerReady: boolean;
  messages: DesktopMessage[];
  lastOwnMessageId: string | null;
}

export interface DesktopClientConfig {
  cdpUrl: string;
  chatId: string;
  chatTitle: string;
  timeoutMs?: number;
}

export interface DesktopOutboundFile {
  path: string;
  size: number;
  kind: DesktopOutboundKind;
  device: number;
  inode: number;
  mtimeMs: number;
}

export type DesktopOutboundKind = "document" | "image" | "video";

interface DesktopAttachmentStatus {
  ready: boolean;
  size: number | null;
  mimeType: string | null;
}

export const DEFAULT_DESKTOP_MEDIA_MAX_MB = 20;
export const MAX_DESKTOP_MEDIA_MAX_MB = 100;
export const DESKTOP_ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const MAX_DESKTOP_ATTACHMENT_CHUNKS =
  (MAX_DESKTOP_MEDIA_MAX_MB * 1024 * 1024) / DESKTOP_ATTACHMENT_CHUNK_BYTES;
export const DESKTOP_DOCUMENT_INPUT_SELECTOR =
  'input[id^="document-input"][type="file"][accept="*"]';
export const DESKTOP_IMAGE_INPUT_SELECTOR =
  'input[id^="image-input"][type="file"][accept="image/gif,image/jpeg,image/png,image/vnd.microsoft.icon,image/webp,image/bmp"]';
export const DESKTOP_VIDEO_INPUT_SELECTOR =
  'input[id^="video-input"][type="file"][accept="video/*"]';

interface DedupeState {
  version: 2;
  seen: string[];
  updatedAt: string;
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function defaultDesktopMediaRoots(): string[] {
  const openClawHome = resolveUserPath(
    process.env.OPENCLAW_HOME?.trim() || "~/.openclaw",
  );
  return [resolve(openClawHome, "media")];
}

function resolveLocalMediaPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("desktop eXpress media path is required");
  if (trimmed.startsWith("file://")) {
    try {
      return resolve(fileURLToPath(new URL(trimmed)));
    } catch {
      throw new Error("desktop eXpress media file URL is invalid");
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error("desktop eXpress media must be a local file");
  }
  return resolveUserPath(trimmed);
}

function isWithinRoot(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isSensitiveOutboundPath(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((part) =>
      /^(?:\.git|\.env(?:\..*)?|credentials?|secrets?|id_(?:rsa|ecdsa|ed25519)|.*\.(?:key|pem|p12|pfx))$/i.test(
        part,
      ),
    );
}

async function assertPathHasNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("desktop eXpress media path contains a symlink");
    }
  }
}

function classifyDesktopOutboundFile(path: string): DesktopOutboundKind {
  const extension = extname(path).toLowerCase();
  if (
    [".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"].includes(
      extension,
    )
  ) {
    return "image";
  }
  if (
    [
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
    ].includes(extension)
  ) {
    return "video";
  }
  return "document";
}

export function desktopInputSelectorFor(kind: DesktopOutboundKind): string {
  if (kind === "image") return DESKTOP_IMAGE_INPUT_SELECTOR;
  if (kind === "video") return DESKTOP_VIDEO_INPUT_SELECTOR;
  return DESKTOP_DOCUMENT_INPUT_SELECTOR;
}

export async function validateDesktopOutboundFile(
  mediaPath: string,
  maxMb = DEFAULT_DESKTOP_MEDIA_MAX_MB,
  allowedRoots?: string[],
): Promise<DesktopOutboundFile> {
  if (
    !Number.isFinite(maxMb) ||
    maxMb <= 0 ||
    maxMb > MAX_DESKTOP_MEDIA_MAX_MB
  ) {
    throw new Error("desktop eXpress media size limit is invalid");
  }
  const path = resolveLocalMediaPath(mediaPath);
  let file;
  try {
    file = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("desktop eXpress media file does not exist");
    }
    throw error;
  }
  if (!file.isFile()) {
    throw new Error("desktop eXpress media path is not a regular file");
  }
  await assertPathHasNoSymlinkComponents(path);
  const canonicalPath = await realpath(path);
  const canonicalFile = await lstat(canonicalPath);
  if (
    !canonicalFile.isFile() ||
    canonicalFile.dev !== file.dev ||
    canonicalFile.ino !== file.ino ||
    canonicalFile.size !== file.size
  ) {
    throw new Error("desktop eXpress media file changed during validation");
  }
  const roots = allowedRoots?.length
    ? allowedRoots.map(resolveUserPath)
    : defaultDesktopMediaRoots();
  let insideAllowedRoot = false;
  for (const root of roots) {
    try {
      if (isWithinRoot(canonicalPath, await realpath(root))) {
        insideAllowedRoot = true;
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!insideAllowedRoot) {
    throw new Error("desktop eXpress media file is outside allowed roots");
  }
  if (isSensitiveOutboundPath(canonicalPath)) {
    throw new Error("desktop eXpress refuses credential-like media paths");
  }
  const maxBytes = Math.floor(maxMb * 1024 * 1024);
  if (file.size > maxBytes) {
    throw new Error(`desktop eXpress media file exceeds the ${maxMb} MB limit`);
  }
  return {
    path: canonicalPath,
    size: file.size,
    kind: classifyDesktopOutboundFile(canonicalPath),
    device: file.dev,
    inode: file.ino,
    mtimeMs: file.mtimeMs,
  };
}

async function assertDesktopOutboundFileUnchanged(
  file: DesktopOutboundFile,
): Promise<void> {
  await assertPathHasNoSymlinkComponents(file.path);
  const current = await lstat(file.path);
  if (
    !current.isFile() ||
    current.dev !== file.device ||
    current.ino !== file.inode ||
    current.size !== file.size ||
    current.mtimeMs !== file.mtimeMs
  ) {
    throw new Error("desktop eXpress media file changed before delivery");
  }
}

export function normalizeLoopbackCdpUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
    throw new Error("desktop CDP endpoint must use a loopback hostname");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("desktop CDP endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("desktop CDP endpoint must not contain credentials");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeLoopbackCdpSocketUrl(
  value: string,
  cdpUrl: string,
): string {
  const url = new URL(value);
  const base = new URL(normalizeLoopbackCdpUrl(cdpUrl));
  const hostname = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
    throw new Error("desktop CDP websocket must use a loopback hostname");
  }
  const expectedProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== expectedProtocol || url.port !== base.port) {
    throw new Error(
      "desktop CDP websocket must match the configured protocol and port",
    );
  }
  if (url.username || url.password) {
    throw new Error("desktop CDP websocket must not contain credentials");
  }
  return url.toString();
}

async function messageDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

class CdpRpc {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.rejectAll(new Error("desktop CDP connection closed"));
    });
    socket.addEventListener("error", () => {
      this.rejectAll(new Error("desktop CDP connection failed"));
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpRpc> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        rejectPromise(new Error("desktop CDP websocket timeout"));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise(new CdpRpc(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectPromise(new Error("desktop CDP websocket connection failed"));
        },
        { once: true },
      );
    });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ) {
    const id = this.nextId++;
    const reply = await new Promise<CdpReply>(
      (resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          rejectPromise(new Error(`desktop CDP command timed out: ${method}`));
        }, timeoutMs);
        this.pending.set(id, {
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        });
        try {
          this.socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectPromise(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    );
    if (reply.error) {
      throw new Error(
        `desktop CDP ${method} failed: ${reply.error.message ?? reply.error.code}`,
      );
    }
    return reply.result ?? {};
  }

  close(): void {
    this.socket.close();
    this.rejectAll(new Error("desktop CDP connection closed"));
  }

  private async handleMessage(data: unknown): Promise<void> {
    let message: CdpReply;
    try {
      message = JSON.parse(await messageDataToText(data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildDesktopSnapshotExpression(): string {
  return String.raw`(() => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const interestingKeys = new Set(['groupChatId', 'currentChatId', 'chatId']);
    function findChatId(root) {
      const seen = new Set();
      function walk(value, depth) {
        if (depth > 7 || value == null || (typeof value !== 'object' && typeof value !== 'function')) return null;
        if (value instanceof Node || seen.has(value)) return null;
        seen.add(value);
        let keys;
        try { keys = Object.keys(value); } catch { return null; }
        for (const key of keys.slice(0, 300)) {
          let child;
          try { child = value[key]; } catch { continue; }
          if (interestingKeys.has(key) && typeof child === 'string' && uuid.test(child)) return child;
        }
        for (const key of keys.slice(0, 300)) {
          if (['return', 'child', 'sibling', 'alternate', 'stateNode', '_owner'].includes(key)) continue;
          let child;
          try { child = value[key]; } catch { continue; }
          const found = walk(child, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (!root) return null;
      const fiberKey = Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? root[fiberKey] : null;
      for (let index = 0; fiber && index < 80; index += 1, fiber = fiber.return) {
        const found = walk(fiber.memoizedProps, 0) || walk(fiber.memoizedState, 0);
        if (found) return found;
      }
      return null;
    }
    const chatRoot = document.querySelector('.chat');
    const titleNode = document.querySelector('.chat-header-title-container__text');
    function findMessage(node, messageId) {
      const fiberKey = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? node[fiberKey] : null;
      for (let index = 0; fiber && index < 30; index += 1, fiber = fiber.return) {
        const message = fiber.memoizedProps?.message;
        if (message?.syncId === messageId && message.payload && typeof message.payload === 'object') return message;
      }
      return null;
    }
    function attachmentKind(payloadType) {
      if (payloadType === 'image') return 'image';
      if (payloadType === 'audio' || payloadType === 'voice') return 'audio';
      if (payloadType === 'video') return 'video';
      return 'file';
    }
    function findFilePayload(message) {
      const candidates = [
        message?.payload?.payload,
        message?.payload?.file,
        message?.payload,
      ];
      return candidates.find((candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        typeof candidate.fileId === 'string' &&
        typeof candidate.fileName === 'string' &&
        Number.isSafeInteger(candidate.fileSize),
      ) || null;
    }
    const supportedTypes = new Set(['text', 'document', 'image', 'audio', 'voice', 'video']);
    const messages = [...document.querySelectorAll('.chat-message-row--opponent .chat-message')]
      .map((node) => {
        const id = String(node.id || '').trim();
        const message = findMessage(node, id);
        const senderId = String(message?.sender?.userHuid || message?.payload?.from || '').trim();
        const type = node.getAttribute('data-message-type');
        if (!supportedTypes.has(type)) return null;
        const text = String(message?.payload?.body || node.querySelector('.chat-message__text')?.innerText || '').trim();
        if (type === 'text') return { id, senderId, type, text };
        const file = findFilePayload(message);
        const mimeType = String(file?.fileMimeType || 'application/octet-stream').trim().toLowerCase();
        return {
          id,
          senderId,
          type,
          text,
          attachment: {
            fileId: String(file?.fileId || '').trim(),
            fileName: String(file?.fileName || '').trim(),
            fileSize: file?.fileSize,
            mimeType,
            kind: attachmentKind(type),
          },
        };
      })
      .filter((message) => message && uuid.test(message.id) && (message.text.length > 0 || message.attachment));
    const own = [...document.querySelectorAll('.chat-message__bubble--my')]
      .map((node) => node.closest('.chat-message'))
      .filter(Boolean);
    return {
      authenticated: Boolean(document.querySelector('.settings-button__avatar') && chatRoot),
      chatId: findChatId(chatRoot),
      chatTitle: String(titleNode?.innerText || '').split(/\r?\n/, 1)[0].trim() || null,
      composerReady: Boolean(document.querySelector('.slate-message-input[contenteditable="true"]')),
      messages,
      lastOwnMessageId: own.length ? String(own[own.length - 1].id || '').trim() || null : null,
    };
  })()`;
}

function buildOpenChatExpression(chatTitle: string): string {
  const expected = JSON.stringify(chatTitle);
  return `(() => {
    const wanted = ${expected};
    const entry = [...document.querySelectorAll('.chat-list-entry')]
      .find((node) => String(node.querySelector('.chat-list-entry__name')?.innerText || '').trim() === wanted);
    if (!entry) return false;
    entry.click();
    return true;
  })()`;
}

function buildFocusComposerExpression(): string {
  return `(() => {
    const editor = document.querySelector('.slate-message-input[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    return true;
  })()`;
}

function buildAttachmentLookupExpression(messageId: string): string {
  const expected = JSON.stringify(messageId);
  return `(() => {
    const expected = ${expected};
    const node = document.getElementById(expected);
    const supportedTypes = new Set(['document', 'image', 'audio', 'voice', 'video']);
    if (!node || !supportedTypes.has(node.getAttribute('data-message-type')) || !node.closest('.chat-message-row--opponent')) return null;
    const fiberKey = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? node[fiberKey] : null;
    let message = null;
    let loadAttachment = null;
    let attachmentMessage = null;
    for (let index = 0; fiber && index < 30; index += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props?.message?.syncId === expected) {
        message ||= props.message;
        if (props.message?.msgId === expected) attachmentMessage ||= props.message;
        if (typeof props.loadAttachment === 'function') {
          loadAttachment ||= props.loadAttachment;
        }
      }
    }
    let documentOnClick = null;
    const descendants = [...node.querySelectorAll('*')];
    for (const descendant of descendants) {
      const descendantFiberKey = Object.getOwnPropertyNames(descendant).find((key) => key.startsWith('__reactFiber$'));
      let descendantFiber = descendantFiberKey ? descendant[descendantFiberKey] : null;
      for (let index = 0; descendantFiber && index < 15; index += 1, descendantFiber = descendantFiber.return) {
        const props = descendantFiber.memoizedProps;
        const componentName = String(
          descendantFiber.elementType?.displayName ||
          descendantFiber.elementType?.name ||
          descendantFiber.type?.displayName ||
          descendantFiber.type?.name ||
          '',
        );
        if (
          componentName === 'MessageEntryDocument' &&
          props?.message?.syncId === expected &&
          props.message?.msgId === expected
        ) {
          attachmentMessage ||= props.message;
          if (typeof props.onClick === 'function') {
            documentOnClick = props.onClick;
            break;
          }
        }
      }
      if (documentOnClick) break;
    }
    return message
      ? { message, attachmentMessage, type: node.getAttribute('data-message-type'), loadAttachment, documentOnClick }
      : null;
  })()`;
}

function buildAttachmentBlobCandidatesSource(): string {
  return `function attachmentBlobCandidates(found) {
    return [
      found.message?.payload?.payload?.fileBlob,
      found.message?.payload?.file?.fileBlob,
      found.message?.payload?.fileBlob,
      found.message?.fileBlob,
      found.attachmentMessage?.payload?.fileBlob,
      found.attachmentMessage?.payload?.payload?.fileBlob,
      found.attachmentMessage?.fileBlob,
    ].filter((value) => value != null);
  }`;
}

export function buildDesktopAttachmentStartExpression(
  messageId: string,
): string {
  const lookup = buildAttachmentLookupExpression(messageId);
  const blobCandidates = buildAttachmentBlobCandidatesSource();
  return `(() => {
    const found = ${lookup};
    if (!found) throw new Error('desktop attachment message is unavailable');
    ${blobCandidates}
    if (attachmentBlobCandidates(found).length > 0) return 'ready';
    if (found.type === 'document') {
      if (typeof found.documentOnClick === 'function') {
        found.documentOnClick({ downloadToBlob: true });
      } else if (typeof found.loadAttachment === 'function' && found.attachmentMessage) {
        found.loadAttachment({ message: found.attachmentMessage, downloadToBlob: true });
      } else {
        throw new Error('desktop document attachment loader is unavailable');
      }
    } else {
      if (typeof found.loadAttachment !== 'function') throw new Error('desktop attachment loader is unavailable');
      found.loadAttachment({ message: found.attachmentMessage || found.message, downloadToBlob: true });
    }
    return 'started';
  })()`;
}

function buildResolveAttachmentBlobSource(messageId: string): string {
  const lookup = buildAttachmentLookupExpression(messageId);
  const blobCandidates = buildAttachmentBlobCandidatesSource();
  return `async () => {
    const found = ${lookup};
    if (!found) return null;
    ${blobCandidates}
    const candidates = attachmentBlobCandidates(found);
    const value = candidates[0];
    if (candidates.some((candidate) => candidate !== value)) {
      throw new Error('desktop attachment blob source is ambiguous');
    }
    if (value instanceof Blob) return value;
    if (typeof value === 'string' && value.startsWith('blob:file:')) {
      const response = await fetch(value, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('desktop attachment blob could not be read');
      return response.blob();
    }
    if (value != null) throw new Error('desktop attachment blob has an unsafe form');
    return null;
  }`;
}

export function buildDesktopAttachmentStatusExpression(
  messageId: string,
): string {
  const resolveBlob = buildResolveAttachmentBlobSource(messageId);
  return `(async () => {
    const blob = await (${resolveBlob})();
    return blob
      ? { ready: true, size: blob.size, mimeType: blob.type || null }
      : { ready: false, size: null, mimeType: null };
  })()`;
}

export function buildDesktopAttachmentChunkExpression(
  messageId: string,
  offset: number,
  length: number,
): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("desktop attachment chunk offset is invalid");
  }
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("desktop attachment chunk length is invalid");
  }
  const resolveBlob = buildResolveAttachmentBlobSource(messageId);
  return `(async () => {
    const blob = await (${resolveBlob})();
    if (!blob) throw new Error('desktop attachment blob is unavailable');
    const bytes = new Uint8Array(await blob.slice(${offset}, ${offset + length}).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return { base64: btoa(binary), size: bytes.length };
  })()`;
}

export function isDesktopAttachmentMimeCompatible(
  declaredMimeType: string,
  blobMimeType: string | null,
): boolean {
  const declared = declaredMimeType.trim().toLowerCase();
  const actual = blobMimeType?.trim().toLowerCase() ?? "";
  if (!actual || actual === declared || actual === "application/octet-stream") {
    return true;
  }
  const openXmlTypes = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);
  return (
    openXmlTypes.has(declared) &&
    (actual === "application/zip" || actual === "application/x-zip-compressed")
  );
}

function extractEvaluationValue<T>(result: Record<string, unknown>): T {
  const outer = result.result as Record<string, unknown> | undefined;
  if (!outer) throw new Error("desktop CDP evaluation returned no result");
  if (outer.exceptionDetails)
    throw new Error("desktop CDP evaluation raised an exception");
  return outer.value as T;
}

export class ExpressDesktopClient {
  private rpc: CdpRpc | null = null;
  private readonly cdpUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: DesktopClientConfig) {
    this.cdpUrl = normalizeLoopbackCdpUrl(config.cdpUrl);
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    if (this.rpc) return;
    const response = await fetch(`${this.cdpUrl}/json/list`, {
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `desktop CDP target list returned HTTP ${response.status}`,
      );
    const targets = (await response.json()) as CdpTarget[];
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" &&
        Boolean(candidate.webSocketDebuggerUrl) &&
        (candidate.url?.includes("app.asar") || candidate.title === "Web"),
    );
    if (!target?.webSocketDebuggerUrl)
      throw new Error("official eXpress desktop page target not found");
    const socketUrl = normalizeLoopbackCdpSocketUrl(
      target.webSocketDebuggerUrl,
      this.cdpUrl,
    );
    this.rpc = await CdpRpc.connect(socketUrl, this.timeoutMs);
  }

  close(): void {
    this.rpc?.close();
    this.rpc = null;
  }

  async snapshot(): Promise<DesktopSnapshot> {
    const result = await this.evaluate<DesktopSnapshot>(
      buildDesktopSnapshotExpression(),
    );
    return result;
  }

  async openAllowedChat(): Promise<boolean> {
    return this.evaluate<boolean>(
      buildOpenChatExpression(this.config.chatTitle),
    );
  }

  assertSnapshotAllowed(snapshot: DesktopSnapshot): void {
    if (!snapshot.authenticated)
      throw new Error("official eXpress desktop client is not authenticated");
    if (snapshot.chatId !== this.config.chatId)
      throw new Error("active desktop chat UUID is not allowlisted");
    if (snapshot.chatTitle !== this.config.chatTitle)
      throw new Error("active desktop chat title is not allowlisted");
  }

  async sendText(targetChatId: string, text: string): Promise<string> {
    if (targetChatId !== this.config.chatId)
      throw new Error("desktop outbound target is not allowlisted");
    const safeText = text.trim();
    if (!safeText) return "";
    const before = await this.snapshot();
    this.assertSnapshotAllowed(before);
    if (!before.composerReady)
      throw new Error("desktop message composer is unavailable");
    if (!(await this.evaluate<boolean>(buildFocusComposerExpression()))) {
      throw new Error("desktop message composer could not be focused");
    }
    const rpc = this.requireRpc();
    await rpc.request("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await rpc.request("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    });
    await rpc.request("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await rpc.request("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
    await rpc.request("Input.insertText", { text: safeText });
    await rpc.request("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await rpc.request("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const after = await this.snapshot();
      this.assertSnapshotAllowed(after);
      if (
        after.lastOwnMessageId &&
        after.lastOwnMessageId !== before.lastOwnMessageId
      ) {
        return after.lastOwnMessageId;
      }
    }
    throw new Error(
      "desktop outbound message was not confirmed by the official client",
    );
  }

  async downloadAttachment(
    message: DesktopMessage,
    maxBytes: number,
  ): Promise<DesktopDownloadedAttachment> {
    const attachment = message.attachment;
    if (message.type === "text" || !attachment) {
      throw new Error("desktop inbound message has no file attachment");
    }
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_DESKTOP_MEDIA_MAX_MB * 1024 * 1024
    ) {
      throw new Error("desktop inbound media limit is invalid");
    }
    if (attachment.fileSize > maxBytes) {
      throw new Error("desktop inbound attachment exceeds the media limit");
    }

    const before = await this.snapshot();
    this.assertSnapshotAllowed(before);
    const visible = before.messages.find((entry) => entry.id === message.id);
    if (
      !visible?.attachment ||
      visible.senderId !== message.senderId ||
      visible.attachment.fileId !== attachment.fileId ||
      visible.attachment.fileName !== attachment.fileName ||
      visible.attachment.fileSize !== attachment.fileSize ||
      visible.attachment.mimeType.toLowerCase() !== attachment.mimeType
    ) {
      throw new Error("desktop inbound attachment is no longer allowlisted");
    }

    await this.evaluate<string>(
      buildDesktopAttachmentStartExpression(message.id),
    );
    let status: DesktopAttachmentStatus | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await this.evaluate<DesktopAttachmentStatus>(
        buildDesktopAttachmentStatusExpression(message.id),
      );
      if (status.ready) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!status?.ready || status.size == null) {
      throw new Error(
        "desktop inbound attachment was not loaded by the official client",
      );
    }
    if (status.size !== attachment.fileSize) {
      throw new Error(
        "desktop inbound attachment size does not match metadata",
      );
    }
    if (status.size > maxBytes) {
      throw new Error("desktop inbound attachment exceeds the media limit");
    }
    if (
      Math.ceil(status.size / DESKTOP_ATTACHMENT_CHUNK_BYTES) >
      MAX_DESKTOP_ATTACHMENT_CHUNKS
    ) {
      throw new Error("desktop inbound attachment exceeds the chunk limit");
    }
    if (
      !isDesktopAttachmentMimeCompatible(attachment.mimeType, status.mimeType)
    ) {
      throw new Error("desktop inbound attachment MIME type does not match");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (
      let offset = 0;
      offset < status.size;
      offset += DESKTOP_ATTACHMENT_CHUNK_BYTES
    ) {
      const expected = Math.min(
        DESKTOP_ATTACHMENT_CHUNK_BYTES,
        status.size - offset,
      );
      const result = await this.evaluate<{ base64: string; size: number }>(
        buildDesktopAttachmentChunkExpression(message.id, offset, expected),
      );
      const chunk = Buffer.from(result.base64, "base64");
      if (result.size !== expected || chunk.length !== expected) {
        throw new Error("desktop inbound attachment chunk is incomplete");
      }
      if (chunks.length >= MAX_DESKTOP_ATTACHMENT_CHUNKS) {
        throw new Error("desktop inbound attachment exceeds the chunk limit");
      }
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error("desktop inbound attachment exceeds the media limit");
      }
    }
    const buffer = Buffer.concat(chunks, total);
    if (buffer.length !== attachment.fileSize) {
      throw new Error("desktop inbound attachment is incomplete");
    }
    const after = await this.snapshot();
    this.assertSnapshotAllowed(after);
    const afterMessage = after.messages.find(
      (entry) => entry.id === message.id,
    );
    if (
      !afterMessage?.attachment ||
      afterMessage.senderId !== message.senderId ||
      afterMessage.type !== message.type ||
      afterMessage.attachment.fileId !== attachment.fileId ||
      afterMessage.attachment.fileName !== attachment.fileName ||
      afterMessage.attachment.fileSize !== attachment.fileSize ||
      afterMessage.attachment.mimeType.toLowerCase() !== attachment.mimeType
    ) {
      throw new Error("desktop inbound attachment metadata changed");
    }
    return { ...attachment, buffer };
  }

  async sendFile(
    targetChatId: string,
    file: DesktopOutboundFile,
  ): Promise<string> {
    if (targetChatId !== this.config.chatId) {
      throw new Error("desktop outbound target is not allowlisted");
    }
    const before = await this.snapshot();
    this.assertSnapshotAllowed(before);
    if (!before.composerReady) {
      throw new Error("desktop message composer is unavailable");
    }

    const rpc = this.requireRpc();
    const document = await rpc.request(
      "DOM.getDocument",
      { depth: 1, pierce: true },
      this.timeoutMs,
    );
    const root = document.root as CdpDomNode | undefined;
    if (!root?.nodeId) {
      throw new Error("desktop eXpress DOM root is unavailable");
    }
    const selector = desktopInputSelectorFor(file.kind);
    const match = await rpc.request(
      "DOM.querySelector",
      { nodeId: root.nodeId, selector },
      this.timeoutMs,
    );
    const nodeId = match.nodeId as number | undefined;
    if (!nodeId) {
      throw new Error(`desktop eXpress ${file.kind} input is unavailable`);
    }
    const immediatelyBeforeSend = await this.snapshot();
    this.assertSnapshotAllowed(immediatelyBeforeSend);
    if (
      immediatelyBeforeSend.lastOwnMessageId !== before.lastOwnMessageId ||
      !immediatelyBeforeSend.composerReady
    ) {
      throw new Error("desktop eXpress chat changed before file delivery");
    }
    await assertDesktopOutboundFileUnchanged(file);
    await rpc.request(
      "DOM.setFileInputFiles",
      { files: [file.path], nodeId },
      this.timeoutMs,
    );

    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const after = await this.snapshot();
      this.assertSnapshotAllowed(after);
      if (
        after.lastOwnMessageId &&
        after.lastOwnMessageId !== before.lastOwnMessageId
      ) {
        return after.lastOwnMessageId;
      }
    }
    throw new Error(
      "desktop outbound file was not confirmed by the official client",
    );
  }

  private async evaluate<T>(expression: string): Promise<T> {
    await this.connect();
    const result = await this.requireRpc().request(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.timeoutMs,
    );
    return extractEvaluationValue<T>(result);
  }

  private requireRpc(): CdpRpc {
    if (!this.rpc) throw new Error("desktop CDP client is not connected");
    return this.rpc;
  }
}

export class DesktopDedupeStore {
  private readonly seen = new Set<string>();
  private loaded = false;

  constructor(
    private readonly statePath: string,
    private readonly maxEntries = 2048,
  ) {}

  async load(): Promise<boolean> {
    if (this.loaded) return true;
    this.loaded = true;
    try {
      const state = JSON.parse(
        await readFile(resolveUserPath(this.statePath), "utf8"),
      ) as DedupeState;
      if (state.version !== 2) return false;
      for (const id of state.seen ?? []) this.seen.add(id);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw error;
    }
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  async add(id: string): Promise<void> {
    this.seen.delete(id);
    this.seen.add(id);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value as string | undefined;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
    await this.persist();
  }

  async baseline(ids: string[]): Promise<void> {
    for (const id of ids) this.seen.add(id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const path = resolveUserPath(this.statePath);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${process.pid}.tmp`;
    const state: DedupeState = {
      version: 2,
      seen: [...this.seen],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
}

export async function isDesktopOutboundUnlocked(
  account: ResolvedExpressAccount,
): Promise<boolean> {
  if (
    account.mode !== "desktop" ||
    account.config.desktopOutboundEnabled !== true
  )
    return false;
  const switchPath = account.config.desktopOutboundSwitchPath;
  if (!switchPath) return false;
  try {
    const state = await lstat(resolveUserPath(switchPath));
    const currentUid = process.getuid?.();
    return (
      state.isFile() &&
      !state.isSymbolicLink() &&
      (state.mode & 0o777) === 0o600 &&
      (currentUid == null || state.uid === currentUid)
    );
  } catch {
    return false;
  }
}

export function desktopClientFromAccount(
  account: ResolvedExpressAccount,
  timeoutMs?: number,
): ExpressDesktopClient {
  const cdpUrl = account.config.desktopCdpUrl;
  const chatId = account.config.desktopChatId;
  const chatTitle = account.config.desktopChatTitle;
  if (!cdpUrl || !chatId || !chatTitle)
    throw new Error("desktop eXpress account is incomplete");
  return new ExpressDesktopClient({ cdpUrl, chatId, chatTitle, timeoutMs });
}

export async function probeExpressDesktop(
  account: ResolvedExpressAccount,
  timeoutMs = 10_000,
) {
  const client = desktopClientFromAccount(account, timeoutMs);
  try {
    const snapshot = await client.snapshot();
    client.assertSnapshotAllowed(snapshot);
    if (!snapshot.composerReady)
      return { ok: false, error: "desktop composer unavailable" };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close();
  }
}

export async function sendExpressDesktopMessage(
  account: ResolvedExpressAccount,
  targetChatId: string,
  text: string,
): Promise<string> {
  if (!(await isDesktopOutboundUnlocked(account))) {
    throw new Error("desktop eXpress outbound is locked");
  }
  const client = desktopClientFromAccount(account);
  try {
    return await client.sendText(targetChatId, text);
  } finally {
    client.close();
  }
}

export async function sendExpressDesktopFile(
  account: ResolvedExpressAccount,
  targetChatId: string,
  mediaPath: string,
): Promise<string> {
  if (!(await isDesktopOutboundUnlocked(account))) {
    throw new Error("desktop eXpress outbound is locked");
  }
  const file = await validateDesktopOutboundFile(
    mediaPath,
    account.config.mediaMaxMb ?? DEFAULT_DESKTOP_MEDIA_MAX_MB,
    account.config.desktopMediaRoots,
  );
  if (!(await isDesktopOutboundUnlocked(account))) {
    throw new Error(
      "desktop eXpress outbound was locked during file validation",
    );
  }
  const client = desktopClientFromAccount(account);
  try {
    return await client.sendFile(targetChatId, file);
  } finally {
    client.close();
  }
}
