/**
 * Read/write adapter for the already-authorized official eXpress Electron client.
 *
 * The CDP endpoint must be loopback-only. Reads are restricted to one exact
 * chat UUID and title. Writes additionally require two independent gates:
 * desktopOutboundEnabled=true and the presence of a local switch file.
 */

import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

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

interface PendingRequest {
  resolve: (value: CdpReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopMessage {
  id: string;
  text: string;
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

interface DedupeState {
  version: 1;
  seen: string[];
  updatedAt: string;
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
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
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
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
    const messages = [...document.querySelectorAll('.chat-message-row--opponent .chat-message[data-message-type="text"]')]
      .map((node) => ({
        id: String(node.id || '').trim(),
        text: String(node.querySelector('.chat-message__text')?.innerText || '').trim(),
      }))
      .filter((message) => uuid.test(message.id) && message.text.length > 0);
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
    this.rpc = await CdpRpc.connect(
      target.webSocketDebuggerUrl,
      this.timeoutMs,
    );
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
      version: 1,
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
    await access(resolveUserPath(switchPath));
    return true;
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
