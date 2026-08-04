/**
 * Read/write adapter for the already-authorized official eXpress Electron client.
 *
 * The CDP endpoint must be loopback-only. Reads are restricted to one exact
 * chat UUID and title. Writes additionally require two independent gates:
 * desktopOutboundEnabled=true and the presence of a local switch file.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
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

import {
  type ResolvedExpressAccount,
  resolveExpressDesktopChats,
} from "./accounts.js";

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
  /** Official-client delivery state for own messages, when rendered. */
  deliveryStatus?: string;
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
  ownMessages: DesktopMessage[];
  lastOwnMessageId: string | null;
}

export interface DesktopClientConfig {
  cdpUrl: string;
  /** Legacy single-chat constructor fields. */
  chatId?: string;
  chatTitle?: string;
  chats?: DesktopChatTarget[];
  timeoutMs?: number;
}

export interface DesktopTextSendHooks {
  /** Persist recovery evidence before the native send action is invoked. */
  beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}

export interface DesktopChatTarget {
  chatId: string;
  chatTitle: string;
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
export const DESKTOP_TYPING_FAILSAFE_MS = 8_000;
export const DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT = 1_800;
export const DESKTOP_COMPOSER_SYNC_ATTEMPTS = 20;
export const DESKTOP_COMPOSER_SYNC_POLL_MS = 100;
export const DESKTOP_COMPOSER_STAGE_ATTEMPTS = 2;
export const DESKTOP_RENDERER_AUTH_WAIT_ATTEMPTS = 60;
/**
 * A single command may time out because the renderer was briefly busy. Retry
 * that command once before tearing down a healthy websocket.
 */
export const DESKTOP_EVALUATE_ATTEMPTS = 2;
export const DESKTOP_EVALUATE_RETRY_DELAY_MS = 250;

export interface DesktopPageState {
  authenticated: boolean;
  chatListReady: boolean;
  rendererError: boolean;
}

/** One allowlisted chat as reported by the always-mounted chat list. */
export interface DesktopChatDigestEntry {
  chatId: string;
  lastEventSyncId: string | null;
  unreadCounter: number;
  mentionCounter: number;
  lastEventSenderId: string | null;
}

export interface DesktopChatListDigest {
  authenticated: boolean;
  chatListReady: boolean;
  entries: DesktopChatDigestEntry[];
}

export type DesktopOpenChatResult = "active" | "entry" | "router" | "missing";
export type DesktopSendTextResult =
  | "sent"
  | "composer-missing"
  | "native-action-missing"
  | "chat-mismatch"
  | "text-mismatch";

export type DesktopPrepareTextResult =
  "prepared" | "composer-missing" | "native-action-missing" | "chat-mismatch";

interface DedupeState {
  version: 2 | 3 | 4 | 5 | 6;
  seen: string[];
  acknowledged?: string[];
  /**
   * Events claimed before they enter the in-memory scheduler. Claims are
   * durable so a provider reload cannot submit the same event a second time.
   */
  claimed?: string[] | Record<string, string>;
  failures?: Record<string, number>;
  /** Version 6 records when each event was quarantined. */
  quarantined?: string[] | Record<string, number>;
  updatedAt: string;
}

/**
 * A quarantined event is never retried, so an unbounded quarantine only keeps
 * the health status permanently red. After this age the id is demoted to the
 * ordinary seen set: still suppressed, but no longer reported as an incident.
 */
export const DESKTOP_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DesktopFailureDisposition {
  attempt: number;
  quarantined: boolean;
}

export interface DesktopDedupeHealth {
  seen: number;
  acknowledged: number;
  claimed: number;
  failures: number;
  quarantined: number;
}

const DESKTOP_UI_LOCK_WAIT_MS = 60_000;
const DESKTOP_UI_LOCK_POLL_MS = 25;
const DESKTOP_UI_EMPTY_LOCK_GRACE_MS = 5_000;

interface DesktopUiLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

function desktopUiLockPath(cdpUrl: string): string {
  const openClawHome = resolveUserPath(
    process.env.OPENCLAW_HOME?.trim() || "~/.openclaw",
  );
  const endpointHash = createHash("sha256")
    .update(cdpUrl)
    .digest("hex")
    .slice(0, 20);
  return join(openClawHome, "express", `desktop-ui-${endpointHash}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readDesktopUiLockOwner(
  path: string,
): Promise<DesktopUiLockOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<DesktopUiLockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.token !== "string" ||
      !parsed.token ||
      typeof parsed.acquiredAt !== "number"
    ) {
      return null;
    }
    return parsed as DesktopUiLockOwner;
  } catch {
    return null;
  }
}

async function releaseDesktopUiFileLock(
  path: string,
  token: string,
): Promise<void> {
  const owner = await readDesktopUiLockOwner(path);
  if (owner?.token !== token) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireDesktopUiFileLock(
  path: string,
  waitMs: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    const token = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })}\n`,
        );
      } finally {
        await handle.close();
      }
      return () => releaseDesktopUiFileLock(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = await readDesktopUiLockOwner(path);
    let removeStale = Boolean(owner && !isProcessAlive(owner.pid));
    if (!owner) {
      try {
        const state = await lstat(path);
        removeStale =
          Date.now() - state.mtimeMs >= DESKTOP_UI_EMPTY_LOCK_GRACE_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (removeStale) {
      if (owner) {
        const currentOwner = await readDesktopUiLockOwner(path);
        if (currentOwner?.token !== owner.token) continue;
      } else {
        try {
          const currentState = await lstat(path);
          if (
            Date.now() - currentState.mtimeMs <
            DESKTOP_UI_EMPTY_LOCK_GRACE_MS
          ) {
            continue;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, DESKTOP_UI_LOCK_POLL_MS),
    );
  }
  throw new Error("desktop eXpress cross-process UI lock wait timed out");
}

/**
 * Re-entrant mutex combining in-process FIFO ordering with a filesystem lease.
 * The file lease protects the same CDP endpoint when a standalone OpenClaw CLI
 * process is loaded alongside the long-running Gateway.
 */
export type DesktopUiLockMode = "exclusive" | "local";

export class DesktopUiMutex {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<DesktopUiLockMode>();

  constructor(
    private readonly fileLockPath?: string,
    private readonly fileLockWaitMs = DESKTOP_UI_LOCK_WAIT_MS,
  ) {}

  /** Serialize UI-mutating work against every process on this endpoint. */
  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.run("exclusive", work);
  }

  /**
   * Serialize against this process only, without the cross-process lease.
   * Valid solely for work that cannot change what the client displays: the
   * idle poll would otherwise make a standalone CLI wait on a filesystem
   * lease it never needed.
   */
  async runLocal<T>(work: () => Promise<T>): Promise<T> {
    return this.run("local", work);
  }

  private async run<T>(
    mode: DesktopUiLockMode,
    work: () => Promise<T>,
  ): Promise<T> {
    const current = this.context.getStore();
    if (current === "exclusive") return work();
    if (current === "local") {
      if (mode === "local") return work();
      throw new Error(
        "desktop eXpress UI lock cannot escalate from a read-only section",
      );
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      if (mode === "exclusive" && this.fileLockPath) {
        releaseFileLock = await acquireDesktopUiFileLock(
          this.fileLockPath,
          this.fileLockWaitMs,
        );
      }
      return await this.context.run(mode, work);
    } finally {
      try {
        await releaseFileLock?.();
      } finally {
        release();
      }
    }
  }
}

const desktopUiMutexes = new Map<string, DesktopUiMutex>();

function desktopUiMutexFor(cdpUrl: string): DesktopUiMutex {
  let mutex = desktopUiMutexes.get(cdpUrl);
  if (!mutex) {
    mutex = new DesktopUiMutex(desktopUiLockPath(cdpUrl));
    desktopUiMutexes.set(cdpUrl, mutex);
  }
  return mutex;
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

export function buildDesktopSendFileExpression(
  kind: DesktopOutboundKind,
  fileName: string,
  fileSize: number,
): string {
  const inputSelector = JSON.stringify(desktopInputSelectorFor(kind));
  const expectedName = JSON.stringify(fileName);
  return `(() => {
    const input = document.querySelector(${inputSelector});
    const attachments = document.querySelectorAll('.message-input .input-attachment__file');
    const buttons = document.querySelectorAll('.message-input__actions button');
    const selected = input?.files?.[0];
    if (
      input?.files?.length !== 1 ||
      selected?.name !== ${expectedName} ||
      selected?.size !== ${fileSize} ||
      attachments.length !== 1 ||
      buttons.length !== 1 ||
      buttons[0].disabled
    ) {
      return false;
    }
    buttons[0].click();
    return true;
  })()`;
}

function buildDesktopComposerHasNoAttachmentsExpression(): string {
  return `(() => (
    document.querySelectorAll('.message-input .input-attachment__file').length === 0 &&
    [...document.querySelectorAll('.message-input input[type="file"]')]
      .every((input) => !input.files || input.files.length === 0)
  ))()`;
}

function desktopMessageTypeForOutboundKind(
  kind: DesktopOutboundKind,
): DesktopMessage["type"] {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return "document";
}

export function confirmedDesktopOutboundFileMessageId(
  before: Pick<DesktopSnapshot, "ownMessages">,
  after: Pick<DesktopSnapshot, "ownMessages">,
  file: Pick<DesktopOutboundFile, "path" | "size" | "kind">,
): string | null {
  const previousIds = new Set(before.ownMessages.map((message) => message.id));
  const expectedType = desktopMessageTypeForOutboundKind(file.kind);
  const expectedName = basename(file.path);
  const delivered = after.ownMessages.find(
    (message) =>
      !previousIds.has(message.id) &&
      message.type === expectedType &&
      message.attachment?.fileName === expectedName &&
      message.attachment.fileSize === file.size,
  );
  return delivered?.id ?? null;
}

function normalizeDesktopOutboundText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function confirmedDesktopOutboundTextMessageId(
  before: Pick<DesktopSnapshot, "ownMessages">,
  after: Pick<DesktopSnapshot, "ownMessages">,
  text: string,
): string | null {
  const previousIds = new Set(before.ownMessages.map((message) => message.id));
  const expectedText = normalizeDesktopOutboundText(text);
  const delivered = after.ownMessages.find(
    (message) =>
      !previousIds.has(message.id) &&
      message.type === "text" &&
      (message.deliveryStatus == null ||
        ["sent", "received", "read"].includes(message.deliveryStatus)) &&
      normalizeDesktopOutboundText(message.text) === expectedText,
  );
  return delivered?.id ?? null;
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
    function findFilePayload(message, requireFileId) {
      const candidates = [
        message?.payload?.payload,
        message?.payload?.file,
        message?.payload,
      ];
      return candidates.find((candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        (!requireFileId || typeof candidate.fileId === 'string') &&
        typeof candidate.fileName === 'string' &&
        Number.isSafeInteger(candidate.fileSize),
      ) || null;
    }
    const supportedTypes = new Set(['text', 'document', 'image', 'audio', 'voice', 'video']);
    function parseMessage(node, own) {
      const id = String(node?.id || '').trim();
      const message = findMessage(node, id);
      const senderId = String(message?.sender?.userHuid || message?.payload?.from || '').trim();
      const type = node?.getAttribute?.('data-message-type');
      if (!supportedTypes.has(type)) return null;
      const text = String(message?.payload?.body || node.querySelector('.chat-message__text')?.innerText || '').trim();
      const statusClass = own
        ? String(node.querySelector('.chat-message__status')?.className || '')
        : '';
      const deliveryStatus = statusClass.match(/(?:^|\s)chat-message__status--([a-z-]+)/)?.[1];
      if (type === 'text') return { id, senderId, type, text, deliveryStatus };
      const file = findFilePayload(message, !own);
      if (!file) return null;
      const mimeType = String(file?.fileMimeType || 'application/octet-stream').trim().toLowerCase();
      return {
        id,
        senderId,
        type,
        text,
        deliveryStatus,
        attachment: {
          fileId: String(file?.fileId || id).trim(),
          fileName: String(file?.fileName || '').trim(),
          fileSize: file?.fileSize,
          mimeType,
          kind: attachmentKind(type),
        },
      };
    }
    function validMessage(message) {
      return Boolean(message && uuid.test(message.id) && (message.text.length > 0 || message.attachment));
    }
    const messages = [...document.querySelectorAll('.chat-message-row--opponent .chat-message')]
      .map((node) => parseMessage(node, false))
      .filter(validMessage);
    const ownNodes = [...document.querySelectorAll('.chat-message__bubble--my')]
      .map((node) => node.closest('.chat-message'))
      .filter(Boolean);
    const ownMessages = ownNodes.map((node) => parseMessage(node, true)).filter(validMessage);
    return {
      authenticated: Boolean(document.querySelector('.settings-button__avatar') && chatRoot),
      chatId: findChatId(chatRoot),
      chatTitle: String(titleNode?.innerText || '').split(/\r?\n/, 1)[0].trim() || null,
      composerReady: Boolean(document.querySelector('.slate-message-input[contenteditable="true"]')),
      messages,
      ownMessages,
      lastOwnMessageId: ownNodes.length ? String(ownNodes[ownNodes.length - 1].id || '').trim() || null : null,
    };
  })()`;
}

export function buildDesktopPageStateExpression(): string {
  return `(() => {
    const hasAvatar = Boolean(document.querySelector('.settings-button__avatar'));
    const hasChat = Boolean(document.querySelector('.chat'));
    const chatListReady = Boolean(document.querySelector('.chat-list-entry'));
    const authenticated = hasAvatar && (hasChat || chatListReady);
    const text = String(document.body?.innerText || '');
    const rendererError =
      !authenticated &&
      !hasChat &&
      !chatListReady &&
      (
        text.includes('Something went wrong') ||
        text.includes('Что-то пошло не так')
      );
    return { authenticated, chatListReady, rendererError };
  })()`;
}

/**
 * Read the always-mounted chat list without touching the active chat.
 *
 * The official client keeps `lastEventSyncId` and the unread counters on every
 * chat-list entry, so a single evaluation reports whether any allowlisted chat
 * has new traffic. Only chats whose digest changed need the expensive exact
 * navigation, which keeps the renderer idle while nothing is happening.
 */
export function buildDesktopChatListDigestExpression(
  chatIds: readonly string[],
): string {
  const wanted = JSON.stringify(chatIds.map((chatId) => chatId.toLowerCase()));
  return String.raw`(() => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const wanted = new Set(${wanted});
    function chatFor(node) {
      const fiberKey = Object.getOwnPropertyNames(node)
        .find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? node[fiberKey] : null;
      for (let index = 0; fiber && index < 12; index += 1, fiber = fiber.return) {
        const chat = fiber.memoizedProps?.chat;
        if (chat && typeof chat === 'object' && typeof chat.groupChatId === 'string') {
          return chat;
        }
      }
      return null;
    }
    function counter(value) {
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }
    const entries = [];
    const claimed = new Set();
    for (const node of document.querySelectorAll('.chat-list-entry')) {
      const chat = chatFor(node);
      if (!chat) continue;
      const chatId = String(chat.groupChatId).toLowerCase();
      if (!wanted.has(chatId) || claimed.has(chatId)) continue;
      claimed.add(chatId);
      const lastEvent = chat.lastEvent;
      const syncId = String(chat.lastEventSyncId || lastEvent?.syncId || '')
        .trim()
        .toLowerCase();
      const senderId = String(lastEvent?.sender?.userHuid || '')
        .trim()
        .toLowerCase();
      entries.push({
        chatId,
        lastEventSyncId: uuid.test(syncId) ? syncId : null,
        unreadCounter: counter(chat.unreadCounter),
        mentionCounter: counter(chat.mentionCounter),
        lastEventSenderId: uuid.test(senderId) ? senderId : null,
      });
    }
    return {
      authenticated: Boolean(document.querySelector('.settings-button__avatar')),
      chatListReady: Boolean(document.querySelector('.chat-list-entry')),
      entries,
    };
  })()`;
}

/**
 * Select an exact chat UUID. A mounted matching entry is preferred; the
 * official React router is a bounded fallback for virtualized/off-screen
 * entries. The configured title is verified only after navigation.
 */
export function buildOpenChatExpression(chatId: string): string {
  const expected = JSON.stringify(chatId.toLowerCase());
  return `(() => {
    const wanted = ${expected};
    function fiberFor(node) {
      if (!node) return null;
      const fiberKey = Object.getOwnPropertyNames(node)
        .find((key) => key.startsWith('__reactFiber$'));
      return fiberKey ? node[fiberKey] : null;
    }
    function chatIdFromFiber(node) {
      let fiber = fiberFor(node);
      for (let index = 0; fiber && index < 40; index += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const candidates = [
          props?.chat?.groupChatId,
          props?.groupChatId,
          props?.item?.groupChatId,
        ];
        const matched = candidates.find(
          (value) => typeof value === 'string' && value.toLowerCase() === wanted,
        );
        if (matched) return matched;
      }
      return null;
    }
    if (chatIdFromFiber(document.querySelector('.chat'))) return 'active';
    for (const entry of document.querySelectorAll('.chat-list-entry')) {
      if (chatIdFromFiber(entry)) {
        entry.click();
        return 'entry';
      }
    }
    const roots = [
      document.querySelector('.chat'),
      document.querySelector('.chat-list'),
      document.getElementById('root'),
      document.body,
    ].filter(Boolean);
    for (const root of roots) {
      let fiber = fiberFor(root);
      for (let index = 0; fiber && index < 80; index += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const histories = [
          props?.history,
          props?.router?.history,
          props?.route?.history,
        ];
        const history = histories.find(
          (candidate) =>
            candidate &&
            typeof candidate.push === 'function' &&
            typeof candidate.location?.pathname === 'string',
        );
        if (history) {
          history.push('/chats/' + wanted);
          return 'router';
        }
      }
    }
    return 'missing';
  })()`;
}

/**
 * Stage text through the official class component instead of synthetic input.
 * Composer synchronization is polled by Node in separate Runtime.evaluate
 * calls so Chromium cannot collect a long-lived page promise mid-send.
 */
export function buildDesktopPrepareTextExpression(
  chatId: string,
  text: string,
): string {
  const expectedChatId = JSON.stringify(chatId.toLowerCase());
  const expectedText = JSON.stringify(text);
  return `(() => {
    const expectedChatId = ${expectedChatId};
    const expectedText = ${expectedText};
    const editor = document.querySelector('.slate-message-input[contenteditable="true"]');
    if (!editor) return 'composer-missing';
    const fiberKey = Object.getOwnPropertyNames(editor)
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? editor[fiberKey] : null;
    for (let index = 0; fiber && index < 40; index += 1, fiber = fiber.return) {
      const componentName = String(
        fiber.elementType?.displayName ||
        fiber.elementType?.name ||
        fiber.type?.displayName ||
        fiber.type?.name ||
        '',
      );
      const instance = fiber.stateNode;
      if (componentName !== 'ChatInputText' || !instance) continue;
      if (String(instance.props?.chat?.groupChatId || '').toLowerCase() !== expectedChatId) {
        return 'chat-mismatch';
      }
      if (
        typeof instance.setInputText !== 'function' ||
        typeof instance.getMessage !== 'function' ||
        typeof instance.handleSendMessage !== 'function'
      ) {
        return 'native-action-missing';
      }
      editor.focus();
      instance.setInputText({ text: expectedText, mentions: [] });
      return 'prepared';
    }
    return 'native-action-missing';
  })()`;
}

/** Commit only after the official component exposes the exact staged text. */
export function buildDesktopSendTextExpression(
  chatId: string,
  text: string,
): string {
  const expectedChatId = JSON.stringify(chatId.toLowerCase());
  const expectedText = JSON.stringify(text);
  return `(() => {
    const expectedChatId = ${expectedChatId};
    const expectedText = ${expectedText};
    const editor = document.querySelector('.slate-message-input[contenteditable="true"]');
    if (!editor) return 'composer-missing';
    const fiberKey = Object.getOwnPropertyNames(editor)
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? editor[fiberKey] : null;
    for (let index = 0; fiber && index < 40; index += 1, fiber = fiber.return) {
      const componentName = String(
        fiber.elementType?.displayName ||
        fiber.elementType?.name ||
        fiber.type?.displayName ||
        fiber.type?.name ||
        '',
      );
      const instance = fiber.stateNode;
      if (componentName !== 'ChatInputText' || !instance) continue;
      if (String(instance.props?.chat?.groupChatId || '').toLowerCase() !== expectedChatId) {
        return 'chat-mismatch';
      }
      if (
        typeof instance.getMessage !== 'function' ||
        typeof instance.handleSendMessage !== 'function'
      ) {
        return 'native-action-missing';
      }
      const message = instance.getMessage();
      const actualText = String(message?.text || '')
        .replace(/\\r\\n/g, '\\n')
        .replace(/\\n$/, '');
      if (actualText !== expectedText.replace(/\\r\\n/g, '\\n')) {
        return 'text-mismatch';
      }
      instance.handleSendMessage();
      return 'sent';
    }
    return 'native-action-missing';
  })()`;
}

export function buildDesktopTextActionAvailableExpression(
  chatId: string,
): string {
  const expectedChatId = JSON.stringify(chatId.toLowerCase());
  return `(() => {
    const expectedChatId = ${expectedChatId};
    const editor = document.querySelector('.slate-message-input[contenteditable="true"]');
    if (!editor) return false;
    const fiberKey = Object.getOwnPropertyNames(editor)
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? editor[fiberKey] : null;
    for (let index = 0; fiber && index < 40; index += 1, fiber = fiber.return) {
      const componentName = String(
        fiber.elementType?.displayName ||
        fiber.elementType?.name ||
        fiber.type?.displayName ||
        fiber.type?.name ||
        '',
      );
      const instance = fiber.stateNode;
      if (
        componentName === 'ChatInputText' &&
        String(instance?.props?.chat?.groupChatId || '').toLowerCase() === expectedChatId
      ) {
        return Boolean(
          typeof instance.setInputText === 'function' &&
          typeof instance.getMessage === 'function' &&
          typeof instance.handleSendMessage === 'function'
        );
      }
    }
    return false;
  })()`;
}

/**
 * Invoke the official client's own typing action without mutating the editor.
 * The exact component/chat checks make client drift fail closed; callers can
 * then use a configured text acknowledgement as a compatibility fallback.
 */
export function buildDesktopTypingExpression(
  chatId: string,
  active: boolean,
): string {
  const expected = JSON.stringify(chatId);
  return `(() => {
    const expected = ${expected};
    const editor = document.querySelector('.slate-message-input[contenteditable="true"]');
    if (!editor) return false;
    const fiberKey = Object.getOwnPropertyNames(editor).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? editor[fiberKey] : null;
    for (let index = 0; fiber && index < 40; index += 1, fiber = fiber.return) {
      const componentName = String(
        fiber.elementType?.displayName ||
        fiber.elementType?.name ||
        fiber.type?.displayName ||
        fiber.type?.name ||
        '',
      );
      const props = fiber.memoizedProps;
      if (
        componentName === 'ChatInputText' &&
        props?.chat?.groupChatId === expected &&
        typeof props.onUserTyping === 'function'
      ) {
        const timerKey = Symbol.for('openclaw.express.desktopTypingStopTimer');
        const previousTimer = globalThis[timerKey];
        if (previousTimer) clearTimeout(previousTimer);
        props.onUserTyping(expected, ${active ? "true" : "false"});
        if (${active ? "true" : "false"}) {
          globalThis[timerKey] = setTimeout(() => {
            try { props.onUserTyping(expected, false); } catch {}
            delete globalThis[timerKey];
          }, ${DESKTOP_TYPING_FAILSAFE_MS});
        } else {
          delete globalThis[timerKey];
        }
        return true;
      }
    }
    return false;
  })()`;
}

function buildAttachmentLookupExpression(messageId: string): string {
  const expected = JSON.stringify(messageId);
  return `(() => {
    const expected = ${expected};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const node = document.getElementById(expected);
    const supportedTypes = new Set(['document', 'image', 'audio', 'voice', 'video']);
    if (!node || !supportedTypes.has(node.getAttribute('data-message-type')) || !node.closest('.chat-message-row--opponent')) return null;
    const fiberKey = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? node[fiberKey] : null;
    let message = null;
    const messages = [];
    let envelopeLoadAttachment = null;
    let attachmentLoadAttachment = null;
    let attachmentMessage = null;
    const attachmentMessages = [];
    const addUnique = (values, value) => {
      if (value && !values.includes(value)) values.push(value);
    };
    const attachmentFilePayload = (value) => [
      value?.payload?.payload,
      value?.payload?.file,
      value?.payload,
    ].find((candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.fileId === 'string' &&
      typeof candidate.fileName === 'string' &&
      Number.isSafeInteger(candidate.fileSize),
    ) || null;
    const matchesAttachmentEnvelope = (candidate) => {
      const outerFile = attachmentFilePayload(message);
      const innerFile = attachmentFilePayload(candidate);
      return Boolean(
        outerFile &&
        innerFile &&
        innerFile.fileId === outerFile.fileId &&
        innerFile.fileName === outerFile.fileName &&
        innerFile.fileSize === outerFile.fileSize &&
        String(innerFile.fileMimeType || 'application/octet-stream').trim().toLowerCase() ===
          String(outerFile.fileMimeType || 'application/octet-stream').trim().toLowerCase()
      );
    };
    for (let index = 0; fiber && index < 30; index += 1, fiber = fiber.return) {
      for (const candidateFiber of [fiber, fiber.alternate].filter(Boolean)) {
        const props = candidateFiber.memoizedProps;
        if (props?.message?.syncId === expected) {
          message ||= props.message;
          addUnique(messages, props.message);
          const componentName = String(
            candidateFiber.elementType?.displayName ||
            candidateFiber.elementType?.name ||
            candidateFiber.type?.displayName ||
            candidateFiber.type?.name ||
            '',
          );
          if (
            typeof props.message?.msgId === 'string' &&
            uuid.test(props.message.msgId) &&
            matchesAttachmentEnvelope(props.message)
          ) {
            addUnique(attachmentMessages, props.message);
          }
          if (
            componentName === 'MessageEntryBody' &&
            typeof props.message?.msgId === 'string' &&
            uuid.test(props.message.msgId) &&
            matchesAttachmentEnvelope(props.message) &&
            typeof props.loadAttachment === 'function'
          ) {
            attachmentMessage ||= props.message;
            attachmentLoadAttachment ||= props.loadAttachment;
          }
          if (typeof props.loadAttachment === 'function') {
            envelopeLoadAttachment ||= props.loadAttachment;
          }
        }
      }
    }
    let documentOnClick = null;
    const descendants = [...node.querySelectorAll('*')];
    for (const descendant of descendants) {
      const descendantFiberKey = Object.getOwnPropertyNames(descendant).find((key) => key.startsWith('__reactFiber$'));
      let descendantFiber = descendantFiberKey ? descendant[descendantFiberKey] : null;
      for (let index = 0; descendantFiber && index < 15; index += 1, descendantFiber = descendantFiber.return) {
        for (const candidateFiber of [descendantFiber, descendantFiber.alternate].filter(Boolean)) {
          const props = candidateFiber.memoizedProps;
          const componentName = String(
            candidateFiber.elementType?.displayName ||
            candidateFiber.elementType?.name ||
            candidateFiber.type?.displayName ||
            candidateFiber.type?.name ||
            '',
          );
          if (
            props?.message?.syncId === expected &&
            typeof props.message?.msgId === 'string' &&
            uuid.test(props.message.msgId) &&
            matchesAttachmentEnvelope(props.message)
          ) {
            addUnique(messages, props.message);
            addUnique(attachmentMessages, props.message);
            if (
              componentName === 'MessageEntryBody' &&
              typeof props.loadAttachment === 'function'
            ) {
              attachmentMessage ||= props.message;
              attachmentLoadAttachment ||= props.loadAttachment;
            }
          }
          if (
            componentName === 'MessageEntryDocument' &&
            props?.message?.syncId === expected &&
            typeof props.message?.msgId === 'string' &&
            uuid.test(props.message.msgId) &&
            matchesAttachmentEnvelope(props.message)
          ) {
            addUnique(messages, props.message);
            addUnique(attachmentMessages, props.message);
            if (typeof props.onClick === 'function') {
              documentOnClick ||= props.onClick;
            }
          }
        }
      }
    }
    return message
      ? {
          message,
          messages,
          attachmentMessage: attachmentMessage || attachmentMessages[0] || null,
          attachmentMessages,
          type: node.getAttribute('data-message-type'),
          loadAttachment: attachmentLoadAttachment || envelopeLoadAttachment,
          documentOnClick,
        }
      : null;
  })()`;
}

function buildAttachmentBlobCandidatesSource(): string {
  return `function attachmentBlobCandidates(found) {
    const exactMessages = [
      ...(Array.isArray(found.attachmentMessages) ? found.attachmentMessages : []),
      found.attachmentMessage,
    ].filter(Boolean);
    const messages = exactMessages.length > 0
      ? exactMessages
      : [...(Array.isArray(found.messages) ? found.messages : []), found.message].filter(Boolean);
    const candidates = [];
    for (const message of messages) {
      candidates.push(
        message?.payload?.payload?.fileBlob,
        message?.payload?.file?.fileBlob,
        message?.payload?.fileBlob,
        message?.fileBlob,
      );
    }
    return candidates.filter((value) => value != null);
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
    if (typeof found.loadAttachment === 'function' && found.attachmentMessage) {
      found.loadAttachment({ message: found.attachmentMessage, downloadToBlob: true });
    } else if (found.type === 'document' && typeof found.documentOnClick === 'function') {
      found.documentOnClick({ downloadToBlob: true });
    } else {
      throw new Error('desktop exact attachment loader is unavailable');
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
  if (
    (declared.startsWith("image/") && actual.startsWith("image/")) ||
    (declared.startsWith("audio/") && actual.startsWith("audio/")) ||
    (declared.startsWith("video/") && actual.startsWith("video/"))
  ) {
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

export function isDesktopCommandTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("desktop CDP command timed out");
}

/** Transient transport faults that deserve one in-place retry. */
export function isRetryableDesktopCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isDesktopCommandTimeout(error) ||
    message === "desktop CDP connection closed" ||
    message === "desktop CDP connection failed"
  );
}

function extractEvaluationValue<T>(result: Record<string, unknown>): T {
  if (result.exceptionDetails)
    throw new Error("desktop CDP evaluation raised an exception");
  const outer = result.result as Record<string, unknown> | undefined;
  if (!outer) throw new Error("desktop CDP evaluation returned no result");
  return outer.value as T;
}

export class ExpressDesktopClient {
  private rpc: CdpRpc | null = null;
  private readonly cdpUrl: string;
  private readonly timeoutMs: number;
  private readonly chats = new Map<string, DesktopChatTarget>();
  private readonly uiMutex: DesktopUiMutex;

  constructor(private readonly config: DesktopClientConfig) {
    this.cdpUrl = normalizeLoopbackCdpUrl(config.cdpUrl);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    const targets = config.chats?.length
      ? config.chats
      : config.chatId && config.chatTitle
        ? [{ chatId: config.chatId, chatTitle: config.chatTitle }]
        : [];
    const chatTitles = new Set<string>();
    for (const target of targets) {
      const chatId = target.chatId.toLowerCase();
      const chatTitle = target.chatTitle.trim();
      if (this.chats.has(chatId)) {
        throw new Error("desktop eXpress chat allowlist contains duplicates");
      }
      if (chatTitles.has(chatTitle)) {
        throw new Error(
          "desktop eXpress chat title allowlist contains duplicates",
        );
      }
      chatTitles.add(chatTitle);
      this.chats.set(chatId, {
        chatId,
        chatTitle,
      });
    }
    if (!this.chats.size) {
      throw new Error("desktop eXpress chat allowlist is empty");
    }
    this.uiMutex = desktopUiMutexFor(this.cdpUrl);
  }

  withUiLock<T>(work: () => Promise<T>): Promise<T> {
    return this.uiMutex.runExclusive(work);
  }

  /** Run an evaluation that cannot change what the client displays. */
  withReadLock<T>(work: () => Promise<T>): Promise<T> {
    return this.uiMutex.runLocal(work);
  }

  async connect(): Promise<void> {
    // Establishing the socket does not touch the UI, so it never needs the
    // cross-process lease.
    return this.uiMutex.runLocal(() => this.connectUnlocked());
  }

  private async connectUnlocked(): Promise<void> {
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
    return this.withUiLock(() => this.snapshotUnlocked());
  }

  private async snapshotUnlocked(): Promise<DesktopSnapshot> {
    const result = await this.evaluate<DesktopSnapshot>(
      buildDesktopSnapshotExpression(),
    );
    return result;
  }

  async openAllowedChat(targetChatId?: string): Promise<boolean> {
    return this.withUiLock(async () => {
      const target = this.resolveTarget(targetChatId);
      await this.ensureTargetActive(target.chatId);
      return true;
    });
  }

  async snapshotAllowed(targetChatId: string): Promise<DesktopSnapshot> {
    return this.withUiLock(() => this.ensureTargetActive(targetChatId));
  }

  /**
   * Report per-chat activity markers without navigating anywhere. Chats the
   * client has not mounted are simply absent from `entries`; the caller must
   * treat a missing chat as "unknown", never as "nothing new".
   */
  async chatListDigest(): Promise<DesktopChatListDigest> {
    return this.withReadLock(() =>
      this.evaluate<DesktopChatListDigest>(
        buildDesktopChatListDigestExpression([...this.chats.keys()]),
      ),
    );
  }

  async textActionAvailable(targetChatId: string): Promise<boolean> {
    return this.withUiLock(async () => {
      const target = this.resolveTarget(targetChatId);
      await this.ensureTargetActive(target.chatId);
      return this.evaluate<boolean>(
        buildDesktopTextActionAvailableExpression(target.chatId),
      );
    });
  }

  assertSnapshotAllowed(
    snapshot: DesktopSnapshot,
    targetChatId?: string,
  ): void {
    const target = this.resolveTarget(targetChatId);
    if (!snapshot.authenticated)
      throw new Error("official eXpress desktop client is not authenticated");
    if (snapshot.chatId?.toLowerCase() !== target.chatId)
      throw new Error("active desktop chat UUID is not allowlisted");
    if (snapshot.chatTitle !== target.chatTitle)
      throw new Error("active desktop chat title is not allowlisted");
  }

  async sendText(
    targetChatId: string,
    text: string,
    hooks?: DesktopTextSendHooks,
  ): Promise<string> {
    return this.withUiLock(() =>
      this.sendTextUnlocked(targetChatId, text, hooks),
    );
  }

  private async sendTextUnlocked(
    targetChatId: string,
    text: string,
    hooks?: DesktopTextSendHooks,
  ): Promise<string> {
    const target = this.resolveTarget(targetChatId);
    const safeText = text.trim();
    if (!safeText) return "";
    if (safeText.length > DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT) {
      throw new Error(
        `desktop eXpress text exceeds the safe ${DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT}-character limit`,
      );
    }
    const before = await this.ensureTargetActive(target.chatId);
    if (!before.composerReady)
      throw new Error("desktop message composer is unavailable");
    try {
      await hooks?.beforeDispatch?.(before);
      const dispatched = await this.stageAndDispatchTextUnlocked(
        target.chatId,
        safeText,
      );
      if (dispatched !== "sent") {
        throw new Error(
          `desktop native text send failed closed: ${dispatched}`,
        );
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        const after = await this.snapshotUnlocked();
        this.assertSnapshotAllowed(after, target.chatId);
        const messageId = confirmedDesktopOutboundTextMessageId(
          before,
          after,
          safeText,
        );
        if (messageId) return messageId;
      }
      throw new Error(
        "desktop outbound message was not confirmed by the official client",
      );
    } catch (error) {
      if (!(await this.recoverRendererIfNeededUnlocked())) throw error;
      const afterRecovery = await this.ensureTargetActive(target.chatId, false);
      const messageId = confirmedDesktopOutboundTextMessageId(
        before,
        afterRecovery,
        safeText,
      );
      if (messageId) {
        return messageId;
      }
      throw new Error(
        "desktop outbound delivery state is unknown after renderer recovery; message was not retried",
      );
    }
  }

  private async stageAndDispatchTextUnlocked(
    targetChatId: string,
    text: string,
  ): Promise<DesktopSendTextResult> {
    let dispatched: DesktopSendTextResult = "text-mismatch";
    for (
      let stageAttempt = 0;
      stageAttempt < DESKTOP_COMPOSER_STAGE_ATTEMPTS;
      stageAttempt += 1
    ) {
      const prepared = await this.evaluate<DesktopPrepareTextResult>(
        buildDesktopPrepareTextExpression(targetChatId, text),
      );
      if (prepared !== "prepared") return prepared;
      for (
        let syncAttempt = 0;
        syncAttempt < DESKTOP_COMPOSER_SYNC_ATTEMPTS;
        syncAttempt += 1
      ) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, DESKTOP_COMPOSER_SYNC_POLL_MS),
        );
        dispatched = await this.evaluate<DesktopSendTextResult>(
          buildDesktopSendTextExpression(targetChatId, text),
        );
        if (dispatched !== "text-mismatch") return dispatched;
      }
    }
    return dispatched;
  }

  async setTyping(targetChatId: string, active: boolean): Promise<void> {
    return this.withUiLock(() => this.setTypingUnlocked(targetChatId, active));
  }

  private async setTypingUnlocked(
    targetChatId: string,
    active: boolean,
  ): Promise<void> {
    const target = this.resolveTarget(targetChatId);
    const before = await this.ensureTargetActive(target.chatId);
    if (!before.composerReady) {
      throw new Error("desktop message composer is unavailable");
    }
    const invoked = await this.evaluate<boolean>(
      buildDesktopTypingExpression(target.chatId, active),
    );
    if (!invoked) {
      throw new Error("desktop native typing action is unavailable");
    }
  }

  async downloadAttachment(
    message: DesktopMessage,
    maxBytes: number,
    targetChatId?: string,
  ): Promise<DesktopDownloadedAttachment> {
    return this.withUiLock(() =>
      this.downloadAttachmentUnlocked(message, maxBytes, targetChatId),
    );
  }

  private async downloadAttachmentUnlocked(
    message: DesktopMessage,
    maxBytes: number,
    targetChatId?: string,
  ): Promise<DesktopDownloadedAttachment> {
    const target = this.resolveTarget(targetChatId);
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

    const before = await this.ensureTargetActive(target.chatId);
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
    const after = await this.snapshotUnlocked();
    this.assertSnapshotAllowed(after, target.chatId);
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
    return this.withUiLock(() => this.sendFileUnlocked(targetChatId, file));
  }

  private async sendFileUnlocked(
    targetChatId: string,
    file: DesktopOutboundFile,
  ): Promise<string> {
    const target = this.resolveTarget(targetChatId);
    const before = await this.ensureTargetActive(target.chatId);
    if (!before.composerReady) {
      throw new Error("desktop message composer is unavailable");
    }
    if (
      !(await this.evaluate<boolean>(
        buildDesktopComposerHasNoAttachmentsExpression(),
      ))
    ) {
      throw new Error("desktop eXpress composer has pending attachments");
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
    const immediatelyBeforeSend = await this.snapshotUnlocked();
    this.assertSnapshotAllowed(immediatelyBeforeSend, target.chatId);
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

    let dispatched = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      dispatched = await this.evaluate<boolean>(
        buildDesktopSendFileExpression(
          file.kind,
          basename(file.path),
          file.size,
        ),
      );
      if (dispatched) break;
    }
    if (!dispatched) {
      throw new Error(
        "desktop outbound file was not ready in the official client composer",
      );
    }

    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const after = await this.snapshotUnlocked();
      this.assertSnapshotAllowed(after, target.chatId);
      const messageId = confirmedDesktopOutboundFileMessageId(
        before,
        after,
        file,
      );
      if (messageId) return messageId;
    }
    throw new Error(
      "desktop outbound file was not confirmed by the official client",
    );
  }

  private resolveTarget(targetChatId?: string): DesktopChatTarget {
    if (targetChatId) {
      const target = this.chats.get(targetChatId.toLowerCase());
      if (!target)
        throw new Error("desktop outbound target is not allowlisted");
      return target;
    }
    if (this.chats.size !== 1) {
      throw new Error("desktop chat target must be explicit");
    }
    return this.chats.values().next().value as DesktopChatTarget;
  }

  /**
   * Route by exact UUID, then verify both UUID and title. This is deliberately
   * done before every mutating/download operation, even when the requested
   * chat already appears active.
   */
  private async ensureTargetActive(
    targetChatId: string,
    allowRecovery = true,
  ): Promise<DesktopSnapshot> {
    const target = this.resolveTarget(targetChatId);
    let snapshot = await this.snapshotUnlocked();
    if (snapshot.chatId?.toLowerCase() === target.chatId) {
      this.assertSnapshotAllowed(snapshot, target.chatId);
      return snapshot;
    }

    let pageState = await this.pageStateUnlocked();
    if (pageState.rendererError && allowRecovery) {
      await this.reloadRendererUnlocked();
      snapshot = await this.snapshotUnlocked();
      pageState = await this.pageStateUnlocked();
    }
    if (!pageState.authenticated && allowRecovery) {
      for (
        let attempt = 0;
        attempt < DESKTOP_RENDERER_AUTH_WAIT_ATTEMPTS;
        attempt += 1
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        pageState = await this.pageStateUnlocked();
        if (pageState.authenticated) break;
        if (pageState.rendererError) {
          await this.reloadRendererUnlocked();
          snapshot = await this.snapshotUnlocked();
          pageState = await this.pageStateUnlocked();
          break;
        }
      }
    }
    if (!pageState.authenticated) {
      throw new Error("official eXpress desktop client is not authenticated");
    }

    const opened = await this.evaluate<DesktopOpenChatResult>(
      buildOpenChatExpression(target.chatId),
    );
    if (opened === "missing") {
      throw new Error("desktop allowlisted chat UUID could not be routed");
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (attempt) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      snapshot = await this.snapshotUnlocked();
      if (
        snapshot.chatId?.toLowerCase() === target.chatId &&
        snapshot.chatTitle === target.chatTitle
      ) {
        this.assertSnapshotAllowed(snapshot, target.chatId);
        return snapshot;
      }
    }
    throw new Error("desktop active chat did not match the allowlisted target");
  }

  private async pageStateUnlocked(): Promise<DesktopPageState> {
    return this.evaluate<DesktopPageState>(buildDesktopPageStateExpression());
  }

  private async recoverRendererIfNeededUnlocked(): Promise<boolean> {
    const pageState = await this.pageStateUnlocked();
    if (!pageState.rendererError) return false;
    await this.reloadRendererUnlocked();
    return true;
  }

  private async reloadRendererUnlocked(): Promise<void> {
    await this.requireRpc().request(
      "Page.reload",
      { ignoreCache: false },
      this.timeoutMs,
    );
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      try {
        const state = await this.pageStateUnlocked();
        if (state.authenticated && !state.rendererError) return;
      } catch {
        // Execution contexts are briefly unavailable while Electron reloads.
      }
    }
    throw new Error(
      "official eXpress desktop renderer did not recover after reload",
    );
  }

  private async evaluate<T>(expression: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < DESKTOP_EVALUATE_ATTEMPTS; attempt += 1) {
      await this.connect();
      try {
        const result = await this.requireRpc().request(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          this.timeoutMs,
        );
        return extractEvaluationValue<T>(result);
      } catch (error) {
        lastError = error;
        if (
          !isRetryableDesktopCommandError(error) ||
          attempt === DESKTOP_EVALUATE_ATTEMPTS - 1
        ) {
          throw error;
        }
        // A closed socket must be rebuilt; a busy renderer only needs time.
        if (!isDesktopCommandTimeout(error)) this.close();
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, DESKTOP_EVALUATE_RETRY_DELAY_MS),
        );
      }
    }
    throw lastError;
  }

  private requireRpc(): CdpRpc {
    if (!this.rpc) throw new Error("desktop CDP client is not connected");
    return this.rpc;
  }
}

interface DesktopDedupeCoordinator {
  mutex: DesktopUiMutex;
  revision: number;
}

const desktopDedupeCoordinators = new Map<string, DesktopDedupeCoordinator>();
const desktopDedupeProcessOwner = `${process.pid}:${randomUUID()}`;

function desktopDedupeCoordinatorFor(
  statePath: string,
): DesktopDedupeCoordinator {
  let coordinator = desktopDedupeCoordinators.get(statePath);
  if (!coordinator) {
    coordinator = { mutex: new DesktopUiMutex(), revision: 0 };
    desktopDedupeCoordinators.set(statePath, coordinator);
  }
  return coordinator;
}

export class DesktopDedupeStore {
  private readonly seen = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly claimed = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly quarantined = new Map<string, number>();
  private readonly resolvedStatePath: string;
  private readonly coordinator: DesktopDedupeCoordinator;
  private loaded = false;
  private loadedRevision = -1;

  constructor(
    statePath: string,
    private readonly maxEntries = 2048,
  ) {
    this.resolvedStatePath = resolveUserPath(statePath);
    this.coordinator = desktopDedupeCoordinatorFor(this.resolvedStatePath);
  }

  async load(): Promise<boolean> {
    return this.coordinator.mutex.runExclusive(async () => {
      if (this.loaded && this.loadedRevision === this.coordinator.revision) {
        return true;
      }
      return this.loadFromDiskUnlocked();
    });
  }

  private async loadFromDiskUnlocked(): Promise<boolean> {
    this.seen.clear();
    this.acknowledged.clear();
    this.claimed.clear();
    this.failures.clear();
    this.quarantined.clear();
    try {
      const state = JSON.parse(
        await readFile(this.resolvedStatePath, "utf8"),
      ) as DedupeState;
      if (
        state.version !== 2 &&
        state.version !== 3 &&
        state.version !== 4 &&
        state.version !== 5 &&
        state.version !== 6
      ) {
        this.loaded = true;
        this.loadedRevision = this.coordinator.revision;
        return false;
      }
      // Pre-v6 files carry no per-event timestamp, and `updatedAt` tracks the
      // whole file, so it says nothing about when an event was quarantined.
      // Treat an unknown age as already expired: the id stays suppressed, and
      // an incident nobody can date stops being reported as current.
      const legacyQuarantinedAt = 0;
      for (const id of state.seen ?? []) this.seen.add(id);
      if (state.version >= 3) {
        for (const id of state.acknowledged ?? []) {
          if (!this.seen.has(id) && !this.quarantined.has(id)) {
            this.acknowledged.add(id);
          }
        }
      }
      if (state.version >= 4) {
        for (const [id, attempts] of Object.entries(state.failures ?? {})) {
          if (
            !this.seen.has(id) &&
            !this.quarantined.has(id) &&
            Number.isSafeInteger(attempts) &&
            attempts > 0
          ) {
            this.failures.set(id, attempts);
          }
        }
        const now = Date.now();
        const quarantined = state.quarantined ?? [];
        const quarantinedEntries: Array<[string, number]> = Array.isArray(
          quarantined,
        )
          ? quarantined.map((id) => [id, legacyQuarantinedAt])
          : Object.entries(quarantined).map(([id, at]) => [
              id,
              Number.isFinite(at) ? at : 0,
            ]);
        for (const [id, quarantinedAt] of quarantinedEntries) {
          if (this.seen.has(id)) continue;
          this.acknowledged.delete(id);
          this.failures.delete(id);
          if (now - quarantinedAt >= DESKTOP_QUARANTINE_TTL_MS) {
            // Expired: keep suppressing the id, stop reporting it.
            this.seen.add(id);
            continue;
          }
          this.quarantined.set(id, quarantinedAt);
        }
      }
      if (
        state.version >= 5 &&
        state.claimed &&
        !Array.isArray(state.claimed)
      ) {
        for (const [id, owner] of Object.entries(state.claimed)) {
          if (
            owner === desktopDedupeProcessOwner &&
            !this.seen.has(id) &&
            !this.quarantined.has(id)
          ) {
            this.claimed.add(id);
          }
        }
      }
      this.loaded = true;
      this.loadedRevision = this.coordinator.revision;
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.loaded = true;
        this.loadedRevision = this.coordinator.revision;
        return false;
      }
      throw error;
    }
  }

  private async refreshIfStaleUnlocked(): Promise<void> {
    if (!this.loaded || this.loadedRevision !== this.coordinator.revision) {
      await this.loadFromDiskUnlocked();
    }
  }

  has(id: string): boolean {
    return (
      this.seen.has(id) || this.claimed.has(id) || this.quarantined.has(id)
    );
  }

  hasAcknowledged(id: string): boolean {
    return this.acknowledged.has(id);
  }

  hasInboundClaim(id: string): boolean {
    return this.claimed.has(id);
  }

  async healthSnapshot(): Promise<DesktopDedupeHealth> {
    return this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      return {
        seen: this.seen.size,
        acknowledged: this.acknowledged.size,
        claimed: this.claimed.size,
        failures: this.failures.size,
        quarantined: this.quarantined.size,
      };
    });
  }

  /**
   * Atomically reserve an inbound event before it enters any in-memory queue.
   * A durable claim is an at-most-once hand-off marker across reload/reconnect.
   */
  async claimInbound(id: string): Promise<boolean> {
    return this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      if (
        this.seen.has(id) ||
        this.claimed.has(id) ||
        this.quarantined.has(id)
      ) {
        return false;
      }
      this.claimed.add(id);
      this.trim(this.claimed);
      try {
        await this.persist();
        return true;
      } catch (error) {
        this.claimed.delete(id);
        throw error;
      }
    });
  }

  /** Release a claim only when the event was proven not to reach dispatch. */
  async releaseInboundClaim(id: string): Promise<void> {
    await this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      if (!this.claimed.delete(id)) return;
      try {
        await this.persist();
      } catch (error) {
        this.claimed.add(id);
        throw error;
      }
    });
  }

  /** Reserve one acknowledgement before invoking the official client. */
  async claimAcknowledgement(id: string): Promise<boolean> {
    return this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      if (
        this.seen.has(id) ||
        this.quarantined.has(id) ||
        this.acknowledged.has(id)
      ) {
        return false;
      }
      this.acknowledged.add(id);
      this.trim(this.acknowledged);
      try {
        await this.persist();
        return true;
      } catch (error) {
        this.acknowledged.delete(id);
        throw error;
      }
    });
  }

  async add(id: string): Promise<void> {
    await this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      this.seen.delete(id);
      this.seen.add(id);
      this.claimed.delete(id);
      this.acknowledged.delete(id);
      this.failures.delete(id);
      this.quarantined.delete(id);
      this.trim(this.seen);
      await this.persist();
    });
  }

  /** Retry one poison event finitely, then durably quarantine only that id. */
  async recordFailure(
    id: string,
    maxAttempts: number,
  ): Promise<DesktopFailureDisposition> {
    return this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error("desktop inbound retry limit is invalid");
      }
      if (this.seen.has(id) || this.quarantined.has(id)) {
        return {
          attempt: this.failures.get(id) ?? maxAttempts,
          quarantined: true,
        };
      }
      const attempt = (this.failures.get(id) ?? 0) + 1;
      this.claimed.delete(id);
      if (attempt >= maxAttempts) {
        this.failures.delete(id);
        this.acknowledged.delete(id);
        this.quarantined.set(id, Date.now());
        this.trimMap(this.quarantined);
      } else {
        this.failures.set(id, attempt);
        this.trimMap(this.failures);
      }
      await this.persist();
      return { attempt, quarantined: attempt >= maxAttempts };
    });
  }

  async baseline(ids: string[]): Promise<void> {
    await this.coordinator.mutex.runExclusive(async () => {
      await this.refreshIfStaleUnlocked();
      for (const id of ids) {
        this.seen.add(id);
        this.claimed.delete(id);
        this.acknowledged.delete(id);
        this.failures.delete(id);
        this.quarantined.delete(id);
      }
      this.trim(this.seen);
      await this.persist();
    });
  }

  private trim(values: Set<string>): void {
    while (values.size > this.maxEntries) {
      const oldest = values.values().next().value as string | undefined;
      if (!oldest) break;
      values.delete(oldest);
    }
  }

  private trimMap<T>(values: Map<string, T>): void {
    while (values.size > this.maxEntries) {
      const oldest = values.keys().next().value as string | undefined;
      if (!oldest) break;
      values.delete(oldest);
    }
  }

  private async persist(): Promise<void> {
    const path = this.resolvedStatePath;
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${process.pid}.${this.coordinator.revision + 1}.tmp`;
    const state: DedupeState = {
      version: 6,
      seen: [...this.seen],
      acknowledged: [...this.acknowledged],
      claimed: Object.fromEntries(
        [...this.claimed].map((id) => [id, desktopDedupeProcessOwner]),
      ),
      failures: Object.fromEntries(this.failures),
      quarantined: Object.fromEntries(this.quarantined),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    this.coordinator.revision += 1;
    this.loadedRevision = this.coordinator.revision;
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
  const chats = resolveExpressDesktopChats(account);
  if (!cdpUrl || chats.length === 0)
    throw new Error("desktop eXpress account is incomplete");
  return new ExpressDesktopClient({
    cdpUrl,
    chats: chats.map(({ chatId, chatTitle }) => ({ chatId, chatTitle })),
    timeoutMs,
  });
}

export async function probeExpressDesktop(
  account: ResolvedExpressAccount,
  timeoutMs = 10_000,
) {
  const client = desktopClientFromAccount(account, timeoutMs);
  try {
    for (const chat of resolveExpressDesktopChats(account)) {
      const snapshot = await client.snapshotAllowed(chat.chatId);
      client.assertSnapshotAllowed(snapshot, chat.chatId);
      if (!snapshot.composerReady)
        return { ok: false, error: "desktop composer unavailable" };
      if (!(await client.textActionAvailable(chat.chatId))) {
        return { ok: false, error: "desktop native text action unavailable" };
      }
    }
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
  hooks?: DesktopTextSendHooks,
): Promise<string> {
  if (!(await isDesktopOutboundUnlocked(account))) {
    throw new Error("desktop eXpress outbound is locked");
  }
  const client = desktopClientFromAccount(account);
  try {
    return await client.sendText(targetChatId, text, hooks);
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
