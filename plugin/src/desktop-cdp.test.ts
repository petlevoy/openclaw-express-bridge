import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  buildDesktopAttachmentChunkExpression,
  buildDesktopAttachmentStartExpression,
  buildDesktopAttachmentStatusExpression,
  buildDesktopChatListDigestExpression,
  buildDesktopPageStateExpression,
  buildDesktopPrepareTextExpression,
  buildDesktopSendFileExpression,
  buildDesktopSendTextExpression,
  buildDesktopSnapshotExpression,
  buildDesktopTextActionAvailableExpression,
  buildDesktopTypingExpression,
  buildOpenChatExpression,
  confirmedDesktopOutboundFileMessageId,
  confirmedDesktopOutboundTextMessageId,
  DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT,
  DESKTOP_DOCUMENT_INPUT_SELECTOR,
  DESKTOP_IMAGE_INPUT_SELECTOR,
  DESKTOP_QUARANTINE_TTL_MS,
  DESKTOP_VIDEO_INPUT_SELECTOR,
  DesktopDedupeStore,
  desktopInputSelectorFor,
  DesktopUiMutex,
  ExpressDesktopClient,
  isDesktopAttachmentMimeCompatible,
  isDesktopCommandTimeout,
  isDesktopOutboundUnlocked,
  isRetryableDesktopCommandError,
  normalizeLoopbackCdpSocketUrl,
  normalizeLoopbackCdpUrl,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";

describe("eXpress desktop CDP bridge", () => {
  it("serializes all shared desktop UI work", async () => {
    const mutex = new DesktopUiMutex();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const first = mutex.runExclusive(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = mutex.runExclusive(async () => {
      events.push("second");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("serializes desktop UI work across independent process mutexes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-ui-lock-test-"));
    const lockPath = join(directory, "desktop-ui.lock");
    const firstMutex = new DesktopUiMutex(lockPath, 2_000);
    const secondMutex = new DesktopUiMutex(lockPath, 2_000);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const first = firstMutex.runExclusive(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    const second = secondMutex.runExclusive(async () => {
      events.push("second");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("requires an exact UUID and title for every configured target", async () => {
    const chatId = "00000000-0000-4000-8000-000000000001";
    const otherChatId = "00000000-0000-4000-8000-000000000002";
    const client = new ExpressDesktopClient({
      cdpUrl: "http://127.0.0.1:18997",
      chats: [
        { chatId, chatTitle: "Alice" },
        { chatId: otherChatId, chatTitle: "Bob" },
      ],
    });
    const snapshot = {
      authenticated: true,
      chatId,
      chatTitle: "Alice",
      composerReady: true,
      messages: [],
      ownMessages: [],
      lastOwnMessageId: null,
    };
    expect(() => client.assertSnapshotAllowed(snapshot, chatId)).not.toThrow();
    expect(() =>
      client.assertSnapshotAllowed(
        { ...snapshot, chatTitle: "Lookalike" },
        chatId,
      ),
    ).toThrow(/title/);
    expect(() => client.assertSnapshotAllowed(snapshot, otherChatId)).toThrow(
      /UUID/,
    );
    await expect(
      client.sendText("00000000-0000-4000-8000-000000000099", "blocked"),
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      client.sendText(chatId, "x".repeat(DEFAULT_DESKTOP_TEXT_CHUNK_LIMIT + 1)),
    ).rejects.toThrow(/safe 1800-character limit/);
  });

  it("does not expose a proactive renderer refresh operation", () => {
    expect("refreshAllowed" in ExpressDesktopClient.prototype).toBe(false);
  });

  it("reloads a recognized renderer error once before UUID routing", async () => {
    const chatId = "00000000-0000-4000-8000-000000000006";
    const client = new ExpressDesktopClient({
      cdpUrl: "http://127.0.0.1:18997",
      chats: [{ chatId, chatTitle: "Approved" }],
    });
    const snapshot = {
      authenticated: true,
      chatId,
      chatTitle: "Approved",
      composerReady: true,
      messages: [],
      ownMessages: [],
      lastOwnMessageId: null,
    };
    const rpcRequest = vi.fn().mockResolvedValue({});
    const internals = client as unknown as {
      rpc: { request: typeof rpcRequest; close: () => void };
      evaluate: <T>(expression: string) => Promise<T>;
    };
    internals.rpc = { request: rpcRequest, close: () => undefined };
    let snapshotCalls = 0;
    let stateCalls = 0;
    internals.evaluate = async <T>(expression: string): Promise<T> => {
      if (expression.includes("chat-message-row--opponent")) {
        snapshotCalls += 1;
        return (
          snapshotCalls === 1
            ? {
                ...snapshot,
                authenticated: false,
                chatId: null,
                chatTitle: null,
                composerReady: false,
              }
            : snapshot
        ) as T;
      }
      if (expression.includes("rendererError")) {
        stateCalls += 1;
        return (
          stateCalls === 1
            ? {
                authenticated: false,
                chatListReady: false,
                rendererError: true,
              }
            : {
                authenticated: true,
                chatListReady: true,
                rendererError: false,
              }
        ) as T;
      }
      if (expression.includes("history.push('/chats/'")) {
        return "active" as T;
      }
      throw new Error("unexpected expression");
    };

    await expect(client.snapshotAllowed(chatId)).resolves.toEqual(snapshot);
    expect(rpcRequest).toHaveBeenCalledOnce();
    expect(rpcRequest).toHaveBeenCalledWith(
      "Page.reload",
      { ignoreCache: false },
      10_000,
    );
  });

  it("waits through a transient official-client renderer reload", async () => {
    const chatId = "00000000-0000-4000-8000-000000000007";
    const client = new ExpressDesktopClient({
      cdpUrl: "http://127.0.0.1:18997",
      chats: [{ chatId, chatTitle: "Approved" }],
    });
    const snapshot = {
      authenticated: true,
      chatId,
      chatTitle: "Approved",
      composerReady: true,
      messages: [],
      ownMessages: [],
      lastOwnMessageId: null,
    };
    const rpcRequest = vi.fn().mockResolvedValue({});
    const internals = client as unknown as {
      rpc: { request: typeof rpcRequest; close: () => void };
      evaluate: <T>(expression: string) => Promise<T>;
    };
    internals.rpc = { request: rpcRequest, close: () => undefined };
    let snapshotCalls = 0;
    let stateCalls = 0;
    internals.evaluate = async <T>(expression: string): Promise<T> => {
      if (expression.includes("chat-message-row--opponent")) {
        snapshotCalls += 1;
        return (
          snapshotCalls === 1
            ? {
                ...snapshot,
                authenticated: false,
                chatId: null,
                chatTitle: null,
                composerReady: false,
              }
            : snapshot
        ) as T;
      }
      if (expression.includes("rendererError")) {
        stateCalls += 1;
        return (
          stateCalls === 1
            ? {
                authenticated: false,
                chatListReady: false,
                rendererError: false,
              }
            : {
                authenticated: true,
                chatListReady: true,
                rendererError: false,
              }
        ) as T;
      }
      if (expression.includes("history.push('/chats/'")) {
        return "active" as T;
      }
      throw new Error("unexpected expression");
    };

    await expect(client.snapshotAllowed(chatId)).resolves.toEqual(snapshot);
    expect(stateCalls).toBe(2);
    expect(rpcRequest).not.toHaveBeenCalled();
  });

  it("fails closed on a stuck composer without reloading the renderer", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "00000000-0000-4000-8000-000000000008";
      const text = "stuck reply";
      const client = new ExpressDesktopClient({
        cdpUrl: "http://127.0.0.1:18997",
        chats: [{ chatId, chatTitle: "Approved" }],
      });
      const snapshot = {
        authenticated: true,
        chatId,
        chatTitle: "Approved",
        composerReady: true,
        messages: [],
        ownMessages: [],
        lastOwnMessageId: null,
      };
      const rpcRequest = vi.fn().mockResolvedValue({});
      const beforeDispatch = vi.fn().mockResolvedValue(undefined);
      const internals = client as unknown as {
        rpc: { request: typeof rpcRequest; close: () => void };
        evaluate: <T>(expression: string) => Promise<T>;
        sendTextUnlocked: (
          targetChatId: string,
          value: string,
          hooks: { beforeDispatch: typeof beforeDispatch },
        ) => Promise<string>;
      };
      internals.rpc = { request: rpcRequest, close: () => undefined };
      let prepareCalls = 0;
      let commitCalls = 0;
      internals.evaluate = async <T>(expression: string): Promise<T> => {
        if (expression.includes("chat-message-row--opponent")) {
          return snapshot as T;
        }
        if (expression.includes("rendererError")) {
          return {
            authenticated: true,
            chatListReady: true,
            rendererError: false,
          } as T;
        }
        if (expression.includes("instance.setInputText")) {
          prepareCalls += 1;
          return "prepared" as T;
        }
        if (expression.includes("instance.handleSendMessage")) {
          commitCalls += 1;
          return "text-mismatch" as T;
        }
        throw new Error("unexpected expression");
      };

      const result = internals.sendTextUnlocked(chatId, text, {
        beforeDispatch,
      });
      const assertion = expect(result).rejects.toThrow(
        "desktop native text send failed closed: text-mismatch",
      );
      await vi.runAllTimersAsync();

      await assertion;
      expect(prepareCalls).toBe(2);
      expect(commitCalls).toBe(40);
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(rpcRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not claim delivery or reload after a composer mismatch", async () => {
    vi.useFakeTimers();
    try {
      const chatId = "00000000-0000-4000-8000-000000000010";
      const text = "uncommitted reply";
      const client = new ExpressDesktopClient({
        cdpUrl: "http://127.0.0.1:18997",
        chats: [{ chatId, chatTitle: "Approved" }],
      });
      const snapshot = {
        authenticated: true,
        chatId,
        chatTitle: "Approved",
        composerReady: true,
        messages: [],
        ownMessages: [],
        lastOwnMessageId: null,
      };
      const rpcRequest = vi.fn().mockResolvedValue({});
      const internals = client as unknown as {
        rpc: { request: typeof rpcRequest; close: () => void };
        evaluate: <T>(expression: string) => Promise<T>;
        sendTextUnlocked: (
          targetChatId: string,
          value: string,
        ) => Promise<string>;
      };
      internals.rpc = { request: rpcRequest, close: () => undefined };
      let prepareCalls = 0;
      let commitCalls = 0;
      internals.evaluate = async <T>(expression: string): Promise<T> => {
        if (expression.includes("chat-message-row--opponent")) {
          return snapshot as T;
        }
        if (expression.includes("rendererError")) {
          return {
            authenticated: true,
            chatListReady: true,
            rendererError: false,
          } as T;
        }
        if (expression.includes("instance.setInputText")) {
          prepareCalls += 1;
          return "prepared" as T;
        }
        if (expression.includes("instance.handleSendMessage")) {
          commitCalls += 1;
          return "text-mismatch" as T;
        }
        throw new Error("unexpected expression");
      };

      const result = internals.sendTextUnlocked(chatId, text);
      const assertion = expect(result).rejects.toThrow(
        "desktop native text send failed closed: text-mismatch",
      );
      await vi.runAllTimersAsync();

      await assertion;
      expect(prepareCalls).toBe(2);
      expect(commitCalls).toBe(40);
      expect(rpcRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only loopback CDP endpoints", () => {
    expect(normalizeLoopbackCdpUrl("http://127.0.0.1:18997/")).toBe(
      "http://127.0.0.1:18997",
    );
    expect(() => normalizeLoopbackCdpUrl("https://example.com:18997")).toThrow(
      /loopback/,
    );
    expect(() =>
      normalizeLoopbackCdpUrl("http://user:pass@127.0.0.1:18997"),
    ).toThrow(/credentials/);
    expect(
      normalizeLoopbackCdpSocketUrl(
        "ws://127.0.0.1:18997/devtools/page/abc",
        "http://localhost:18997",
      ),
    ).toBe("ws://127.0.0.1:18997/devtools/page/abc");
    expect(() =>
      normalizeLoopbackCdpSocketUrl(
        "ws://example.com:18997/devtools/page/abc",
        "http://127.0.0.1:18997",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      normalizeLoopbackCdpSocketUrl(
        "ws://127.0.0.1:19999/devtools/page/abc",
        "http://127.0.0.1:18997",
      ),
    ).toThrow(/protocol and port/);
  });

  it("builds a read-only snapshot expression for inbound messages", () => {
    const expression = buildDesktopSnapshotExpression();
    expect(expression).toContain("chat-message-row--opponent");
    expect(expression).toContain("groupChatId");
    expect(expression).toContain(
      "'document', 'image', 'audio', 'voice', 'video'",
    );
    expect(expression).toContain("sender?.userHuid");
    expect(expression).toContain("fileMimeType");
    expect(expression).toContain("split(/\\r?\\n/, 1)");
    expect(expression).not.toContain(".click()");
    expect(expression).not.toContain("Input.insertText");
  });

  it("recognizes the renderer error page without confusing an active client", () => {
    const run = (bodyText: string, selectors: Set<string>) =>
      Function(
        "document",
        `return (${buildDesktopPageStateExpression()});`,
      )({
        body: { innerText: bodyText },
        querySelector: (selector: string) =>
          selectors.has(selector) ? {} : null,
      }) as {
        authenticated: boolean;
        chatListReady: boolean;
        rendererError: boolean;
      };

    expect(run("Something went wrong", new Set())).toEqual({
      authenticated: false,
      chatListReady: false,
      rendererError: true,
    });
    expect(
      run("Something went wrong in an old message", new Set([".chat"])),
    ).toEqual({
      authenticated: false,
      chatListReady: false,
      rendererError: false,
    });
    expect(
      run(
        "normal client",
        new Set([".settings-button__avatar", ".chat-list-entry"]),
      ),
    ).toEqual({
      authenticated: true,
      chatListReady: true,
      rendererError: false,
    });
  });

  it("routes by exact chat UUID and never by a lookalike title", () => {
    const chatA = "00000000-0000-4000-8000-000000000001";
    const chatB = "00000000-0000-4000-8000-000000000002";
    const clicks: string[] = [];
    const entry = (chatId: string, title: string) => {
      const node = {
        title,
        click: () => clicks.push(chatId),
      };
      Object.defineProperty(node, "__reactFiber$fixture", {
        value: {
          memoizedProps: { chat: { groupChatId: chatId } },
          return: null,
        },
      });
      return node;
    };
    const entries = [entry(chatA, "Same title"), entry(chatB, "Same title")];
    const result = Function(
      "document",
      `return (${buildOpenChatExpression(chatB)});`,
    )({
      body: {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === ".chat-list-entry" ? entries : [],
    });

    expect(result).toBe("entry");
    expect(clicks).toEqual([chatB]);
    expect(buildOpenChatExpression(chatB)).not.toContain(
      ".chat-list-entry__name",
    );
  });

  it("uses the official router for an off-screen exact chat UUID", () => {
    const chatId = "00000000-0000-4000-8000-000000000003";
    const paths: string[] = [];
    const root = {};
    Object.defineProperty(root, "__reactFiber$fixture", {
      value: {
        memoizedProps: {
          history: {
            location: { pathname: "/chats/current" },
            push: (path: string) => paths.push(path),
          },
        },
        return: null,
      },
    });
    const result = Function(
      "document",
      `return (${buildOpenChatExpression(chatId)});`,
    )({
      body: {},
      getElementById: () => null,
      querySelector: (selector: string) =>
        selector === ".chat-list" ? root : null,
      querySelectorAll: () => [],
    });

    expect(result).toBe("router");
    expect(paths).toEqual([`/chats/${chatId}`]);
  });

  it("sends text only through the exact ChatInputText native contract", () => {
    const chatId = "00000000-0000-4000-8000-000000000004";
    const sent: string[] = [];
    let draft = { text: "", mentions: [] as unknown[] };
    let getMessageCalls = 0;
    const editor = { focus: vi.fn() };
    Object.defineProperty(editor, "__reactFiber$fixture", {
      value: {
        elementType: { displayName: "ChatInputText" },
        stateNode: {
          props: { chat: { groupChatId: chatId } },
          setInputText: (value: typeof draft) => {
            draft = value;
          },
          getMessage: () => {
            getMessageCalls += 1;
            return getMessageCalls < 4
              ? { text: "", mentions: [] as unknown[] }
              : draft;
          },
          handleSendMessage: () => sent.push(draft.text),
        },
        return: null,
      },
    });
    const prepare = (targetChatId: string, text: string) =>
      Function(
        "document",
        `return (${buildDesktopPrepareTextExpression(targetChatId, text)});`,
      )({ querySelector: () => editor }) as string;
    const commit = (targetChatId: string, text: string) =>
      Function(
        "document",
        `return (${buildDesktopSendTextExpression(targetChatId, text)});`,
      )({ querySelector: () => editor }) as string;

    expect(prepare(chatId, "line one\nline two")).toBe("prepared");
    expect(commit(chatId, "line one\nline two")).toBe("text-mismatch");
    expect(commit(chatId, "line one\nline two")).toBe("text-mismatch");
    expect(commit(chatId, "line one\nline two")).toBe("text-mismatch");
    expect(commit(chatId, "line one\nline two")).toBe("sent");
    expect(sent).toEqual(["line one\nline two"]);
    expect(getMessageCalls).toBe(4);
    expect(editor.focus).toHaveBeenCalledOnce();
    expect(prepare("00000000-0000-4000-8000-000000000005", "blocked")).toBe(
      "chat-mismatch",
    );
    expect(sent).toEqual(["line one\nline two"]);
    const available = (targetChatId: string) =>
      Function(
        "document",
        `return (${buildDesktopTextActionAvailableExpression(targetChatId)});`,
      )({ querySelector: () => editor });
    expect(available(chatId)).toBe(true);
    expect(available("00000000-0000-4000-8000-000000000005")).toBe(false);
    expect(buildDesktopSendTextExpression(chatId, "safe")).not.toContain(
      "Input.insertText",
    );
    expect(buildDesktopSendTextExpression(chatId, "safe")).not.toContain(
      "new Promise",
    );
  });

  it("invokes only the exact official-client native typing action", () => {
    const chatId = "00000000-0000-4000-8000-000000000088";
    const calls: Array<[string, boolean]> = [];
    const editor = {};
    Object.defineProperty(editor, "__reactFiber$fixture", {
      value: {
        elementType: { displayName: "ChatInputText" },
        memoizedProps: {
          chat: { groupChatId: chatId },
          onUserTyping: (target: string, active: boolean) =>
            calls.push([target, active]),
        },
        return: null,
      },
    });
    const documentFixture = {
      querySelector: () => editor,
    };
    const run = (expression: string) =>
      Function("document", `return (${expression});`)(documentFixture) as
        boolean | undefined;

    expect(run(buildDesktopTypingExpression(chatId, true))).toBe(true);
    expect(calls).toEqual([[chatId, true]]);
    expect(run(buildDesktopTypingExpression(chatId, false))).toBe(true);
    expect(calls).toEqual([
      [chatId, true],
      [chatId, false],
    ]);
    expect(
      run(
        buildDesktopTypingExpression(
          "00000000-0000-4000-8000-000000000077",
          false,
        ),
      ),
    ).toBe(false);
    expect(calls).toEqual([
      [chatId, true],
      [chatId, false],
    ]);
    expect(buildDesktopTypingExpression(chatId, true)).not.toContain(
      "Input.insertText",
    );
    expect(buildDesktopTypingExpression(chatId, true)).toContain(
      "desktopTypingStopTimer",
    );
  });

  it("uses the official MessageEntry onClick contract and blob URLs", () => {
    const messageId = "00000000-0000-4000-8000-000000000001";
    const expressions = [
      buildDesktopAttachmentStartExpression(messageId),
      buildDesktopAttachmentStatusExpression(messageId),
      buildDesktopAttachmentChunkExpression(messageId, 0, 1024),
    ].join("\n");
    expect(expressions).toContain("downloadToBlob: true");
    expect(expressions).toContain(
      "found.documentOnClick({ downloadToBlob: true })",
    );
    expect(expressions).toContain(
      "found.loadAttachment({ message: found.attachmentMessage, downloadToBlob: true })",
    );
    expect(expressions).toContain("componentName === 'MessageEntryDocument'");
    expect(expressions).toContain("found.attachmentMessages");
    expect(expressions).toContain("attachmentBlobCandidates(found)");
    expect(expressions).toContain("message?.payload?.fileBlob");
    expect(expressions).toContain("value.startsWith('blob:file:')");
    expect(expressions).toContain("blob.slice(0, 1024)");
    expect(expressions).not.toMatch(/cookie|authorization|bearer/i);
    expect(() =>
      buildDesktopAttachmentChunkExpression(messageId, -1, 1),
    ).toThrow(/offset/);
  });

  it("reads a captioned document and its nested downloaded fileBlob", async () => {
    class FixtureNode {
      id = "";
      className = "";
      innerText = "";
      parentElement: FixtureNode | null = null;
      attributes = new Map<string, string>();
      descendants: FixtureNode[] = [];

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      closest(selector: string) {
        return selector === ".chat-message-row--opponent" ? this : null;
      }

      querySelector(selector: string) {
        if (selector === ".chat-message__text") {
          return { innerText: this.innerText };
        }
        return null;
      }

      querySelectorAll(selector: string) {
        return selector === "*" ? this.descendants : [];
      }
    }

    const messageId = "00000000-0000-4000-8000-000000000011";
    const ownMessageId = "00000000-0000-4000-8000-000000000010";
    const senderId = "00000000-0000-4000-8000-000000000099";
    const chatId = "00000000-0000-4000-8000-000000000088";
    const bytes = new TextEncoder().encode("%PDF-fixture");
    const filePayload: {
      type: string;
      fileId: string;
      fileName: string;
      fileSize: number;
      fileMimeType: string;
      fileBlob?: string;
    } = {
      type: "document",
      fileId: messageId,
      fileName: "KOD-128-180726.PDF",
      fileSize: bytes.length,
      fileMimeType: "application/pdf",
    };
    const message = {
      syncId: messageId,
      sender: { userHuid: senderId },
      payload: {
        type: "document",
        body: "Что это?",
        from: senderId,
        payload: filePayload,
      },
    };
    const documentMessage = {
      ...message.payload,
      syncId: messageId,
      msgId: messageId,
    };

    const messageNode = new FixtureNode();
    messageNode.id = messageId;
    messageNode.attributes.set("data-message-type", "document");
    Object.defineProperty(messageNode, "__reactFiber$fixture", {
      value: { memoizedProps: { message }, return: null },
    });

    const ownMessageNode = new FixtureNode();
    ownMessageNode.id = ownMessageId;
    ownMessageNode.attributes.set("data-message-type", "document");
    Object.defineProperty(ownMessageNode, "__reactFiber$fixture", {
      value: {
        memoizedProps: {
          message: {
            syncId: ownMessageId,
            payload: {
              type: "document",
              payload: {
                file: "/tmp/outbound.docx",
                fileName: "outbound.docx",
                fileSize: 35_240,
                fileMimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              },
            },
          },
        },
        return: null,
      },
    });
    const ownBubble = {
      closest: (selector: string) =>
        selector === ".chat-message" ? ownMessageNode : null,
    };

    const documentEntry = new FixtureNode();
    const onClick = ({ downloadToBlob }: { downloadToBlob: boolean }) => {
      if (downloadToBlob) {
        filePayload.fileBlob = "blob:file:fixture";
      }
    };
    Object.defineProperty(documentEntry, "__reactFiber$fixture", {
      value: {
        elementType: { name: "MessageEntryDocument" },
        memoizedProps: { message: documentMessage, onClick },
        return: null,
      },
    });
    messageNode.descendants = [documentEntry];

    const chatRoot = new FixtureNode();
    Object.defineProperty(chatRoot, "__reactFiber$fixture", {
      value: { memoizedProps: { groupChatId: chatId }, return: null },
    });
    const titleNode = new FixtureNode();
    titleNode.innerText = "Approved chat\nstatus";
    const documentFixture = {
      getElementById: (id: string) => (id === messageId ? messageNode : null),
      querySelector: (selector: string) => {
        if (selector === ".chat") return chatRoot;
        if (selector === ".chat-header-title-container__text") {
          return titleNode;
        }
        if (
          selector === ".settings-button__avatar" ||
          selector === '.slate-message-input[contenteditable="true"]'
        ) {
          return new FixtureNode();
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector === ".chat-message-row--opponent .chat-message") {
          return [messageNode];
        }
        if (selector === ".chat-message__bubble--my") {
          return [ownBubble];
        }
        return [];
      },
    };
    const run = <T>(expression: string, fetchImpl?: typeof fetch) =>
      Function(
        "document",
        "Node",
        "fetch",
        `return (${expression});`,
      )(documentFixture, FixtureNode, fetchImpl ?? fetch) as T;

    const snapshot = run<{
      chatId: string;
      chatTitle: string;
      messages: Array<{
        text: string;
        attachment: { fileName: string; fileSize: number; mimeType: string };
      }>;
      ownMessages: Array<{
        id: string;
        attachment: { fileId: string; fileName: string; fileSize: number };
      }>;
    }>(buildDesktopSnapshotExpression());
    expect(snapshot).toMatchObject({
      chatId,
      chatTitle: "Approved chat",
      messages: [
        {
          text: "Что это?",
          attachment: {
            fileName: "KOD-128-180726.PDF",
            fileSize: bytes.length,
            mimeType: "application/pdf",
          },
        },
      ],
      ownMessages: [
        {
          id: ownMessageId,
          attachment: {
            fileId: ownMessageId,
            fileName: "outbound.docx",
            fileSize: 35_240,
          },
        },
      ],
    });

    expect(run<string>(buildDesktopAttachmentStartExpression(messageId))).toBe(
      "started",
    );
    expect(filePayload.fileBlob).toBe("blob:file:fixture");
    const fetchFixture = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("blob:file:fixture");
      return new Response(new Blob([bytes], { type: "application/pdf" }));
    }) as typeof fetch;
    await expect(
      run<Promise<{ ready: boolean; size: number; mimeType: string }>>(
        buildDesktopAttachmentStatusExpression(messageId),
        fetchFixture,
      ),
    ).resolves.toEqual({
      ready: true,
      size: bytes.length,
      mimeType: "application/pdf",
    });
    const chunk = await run<Promise<{ base64: string; size: number }>>(
      buildDesktopAttachmentChunkExpression(messageId, 0, bytes.length),
      fetchFixture,
    );
    expect(Buffer.from(chunk.base64, "base64")).toEqual(Buffer.from(bytes));
    expect(chunk.size).toBe(bytes.length);
  });

  it("falls back to the official generic loader with the document payload", () => {
    class FixtureNode {
      id = "";
      attributes = new Map<string, string>();
      descendants: FixtureNode[] = [];

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      closest(selector: string) {
        return selector === ".chat-message-row--opponent" ? this : null;
      }

      querySelectorAll(selector: string) {
        return selector === "*" ? this.descendants : [];
      }
    }

    const messageId = "00000000-0000-4000-8000-000000000012";
    const filePayload: {
      type: string;
      fileId: string;
      fileName: string;
      fileSize: number;
      fileMimeType: string;
      fileBlob?: string;
    } = {
      type: "document",
      fileId: messageId,
      fileName: "report.xlsx",
      fileSize: 16,
      fileMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    const documentMessage = {
      type: "document",
      msgId: messageId,
      syncId: messageId,
      payload: filePayload,
    };
    const message = {
      syncId: messageId,
      payload: documentMessage,
    };
    const loadAttachment = ({
      message: selected,
      downloadToBlob,
    }: {
      message: typeof documentMessage;
      downloadToBlob: boolean;
    }) => {
      expect(selected).toBe(documentMessage);
      if (downloadToBlob) selected.payload.fileBlob = "blob:file:fallback";
    };

    const messageNode = new FixtureNode();
    messageNode.id = messageId;
    messageNode.attributes.set("data-message-type", "document");
    Object.defineProperty(messageNode, "__reactFiber$fixture", {
      value: {
        memoizedProps: { message, loadAttachment },
        return: null,
      },
    });
    const documentEntry = new FixtureNode();
    Object.defineProperty(documentEntry, "__reactFiber$fixture", {
      value: {
        elementType: { name: "MessageEntryDocument" },
        memoizedProps: { message: documentMessage },
        return: null,
      },
    });
    messageNode.descendants = [documentEntry];
    const documentFixture = {
      getElementById: (id: string) => (id === messageId ? messageNode : null),
    };
    const result = Function(
      "document",
      `return (${buildDesktopAttachmentStartExpression(messageId)});`,
    )(documentFixture) as string;
    expect(result).toBe("started");
    expect(filePayload.fileBlob).toBe("blob:file:fallback");
  });

  it.each([
    {
      label: "PDF from the nested payload",
      suffix: "21",
      fileName: "brief.pdf",
      mimeType: "application/pdf",
      blobMimeType: "application/pdf",
      envelope: "payload",
      loader: "onClick",
    },
    {
      label: "DOCX from the live MessageEntryDocument shape",
      suffix: "22",
      fileName: "brief.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      blobMimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      envelope: "payload",
      loader: "onClick",
    },
    {
      label: "XLSX from the compatible file envelope",
      suffix: "23",
      fileName: "table.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      blobMimeType: "application/octet-stream",
      envelope: "file",
      loader: "loadAttachment",
    },
    {
      label: "PPTX from a direct document payload",
      suffix: "24",
      fileName: "slides.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      blobMimeType: "application/zip",
      envelope: "direct",
      loader: "onClick",
    },
    {
      label: "legacy DOC",
      suffix: "25",
      fileName: "brief.doc",
      mimeType: "application/msword",
      blobMimeType: "application/msword",
      envelope: "payload",
      loader: "loadAttachment",
    },
    {
      label: "legacy XLS",
      suffix: "26",
      fileName: "table.xls",
      mimeType: "application/vnd.ms-excel",
      blobMimeType: "application/octet-stream",
      envelope: "payload",
      loader: "loadAttachment",
    },
    {
      label: "legacy PPT",
      suffix: "27",
      fileName: "slides.ppt",
      mimeType: "application/vnd.ms-powerpoint",
      blobMimeType: "application/vnd.ms-powerpoint",
      envelope: "payload",
      loader: "loadAttachment",
    },
  ] as const)(
    "downloads $label through the same structural parser",
    async ({ suffix, fileName, mimeType, blobMimeType, envelope, loader }) => {
      class FixtureNode {
        id = "";
        innerText = "";
        attributes = new Map<string, string>();
        descendants: FixtureNode[] = [];

        getAttribute(name: string) {
          return this.attributes.get(name) ?? null;
        }

        closest(selector: string) {
          return selector === ".chat-message-row--opponent" ? this : null;
        }

        querySelector(selector: string) {
          if (selector === ".chat-message__text") {
            return { innerText: this.innerText };
          }
          return null;
        }

        querySelectorAll(selector: string) {
          return selector === "*" ? this.descendants : [];
        }
      }

      const messageId = `00000000-0000-4000-8000-0000000000${suffix}`;
      const senderId = "00000000-0000-4000-8000-000000000099";
      const chatId = "00000000-0000-4000-8000-000000000088";
      const bytes = new TextEncoder().encode(`document-${suffix}`);
      const filePayload: {
        type: string;
        fileId: string;
        fileName: string;
        fileSize: number;
        fileMimeType: string;
        fileBlob?: string;
      } = {
        type: "document",
        fileId: messageId,
        fileName,
        fileSize: bytes.length,
        fileMimeType: mimeType,
      };
      const outerPayload =
        envelope === "payload"
          ? { type: "document", from: senderId, payload: filePayload }
          : envelope === "file"
            ? { type: "document", from: senderId, file: filePayload }
            : filePayload;
      const message = {
        syncId: messageId,
        sender: { userHuid: senderId },
        payload: outerPayload,
      };
      const documentMessage = {
        type: "document",
        syncId: messageId,
        msgId: messageId,
        payload: filePayload,
      };
      const attachBlob = () => {
        filePayload.fileBlob = `blob:file:${suffix}`;
      };
      const loadAttachment = ({
        message: selected,
        downloadToBlob,
      }: {
        message: typeof documentMessage;
        downloadToBlob: boolean;
      }) => {
        expect(selected).toBe(documentMessage);
        if (downloadToBlob) attachBlob();
      };
      const onClick = ({ downloadToBlob }: { downloadToBlob: boolean }) => {
        if (downloadToBlob) attachBlob();
      };

      const messageNode = new FixtureNode();
      messageNode.id = messageId;
      messageNode.attributes.set("data-message-type", "document");
      Object.defineProperty(messageNode, "__reactFiber$fixture", {
        value: {
          memoizedProps: { message, loadAttachment },
          return: null,
        },
      });
      const documentEntry = new FixtureNode();
      Object.defineProperty(documentEntry, "__reactFiber$fixture", {
        value: {
          elementType: { name: "MessageEntryDocument" },
          memoizedProps: {
            message: documentMessage,
            ...(loader === "onClick" ? { onClick } : {}),
          },
          return: null,
        },
      });
      messageNode.descendants = [documentEntry];

      const chatRoot = new FixtureNode();
      Object.defineProperty(chatRoot, "__reactFiber$fixture", {
        value: { memoizedProps: { groupChatId: chatId }, return: null },
      });
      const titleNode = new FixtureNode();
      titleNode.innerText = "Approved chat";
      const documentFixture = {
        getElementById: (id: string) => (id === messageId ? messageNode : null),
        querySelector: (selector: string) => {
          if (selector === ".chat") return chatRoot;
          if (selector === ".chat-header-title-container__text") {
            return titleNode;
          }
          if (
            selector === ".settings-button__avatar" ||
            selector === '.slate-message-input[contenteditable="true"]'
          ) {
            return new FixtureNode();
          }
          return null;
        },
        querySelectorAll: (selector: string) =>
          selector === ".chat-message-row--opponent .chat-message"
            ? [messageNode]
            : [],
      };
      const fetchFixture = (async (url: string | URL | Request) => {
        expect(String(url)).toBe(`blob:file:${suffix}`);
        return new Response(new Blob([bytes], { type: blobMimeType }));
      }) as typeof fetch;
      const run = <T>(expression: string) =>
        Function(
          "document",
          "Node",
          "fetch",
          `return (${expression});`,
        )(documentFixture, FixtureNode, fetchFixture) as T;

      const snapshot = run<{
        messages: Array<{
          attachment: {
            fileId: string;
            fileName: string;
            fileSize: number;
            mimeType: string;
          };
        }>;
      }>(buildDesktopSnapshotExpression());
      expect(snapshot.messages[0]?.attachment).toEqual({
        fileId: messageId,
        fileName,
        fileSize: bytes.length,
        mimeType,
        kind: "file",
      });
      expect(
        run<string>(buildDesktopAttachmentStartExpression(messageId)),
      ).toBe("started");
      await expect(
        run<Promise<{ ready: boolean; size: number; mimeType: string }>>(
          buildDesktopAttachmentStatusExpression(messageId),
        ),
      ).resolves.toEqual({
        ready: true,
        size: bytes.length,
        mimeType: blobMimeType,
      });
      const chunk = await run<Promise<{ base64: string; size: number }>>(
        buildDesktopAttachmentChunkExpression(messageId, 0, bytes.length),
      );
      expect(Buffer.from(chunk.base64, "base64")).toEqual(Buffer.from(bytes));
      expect(isDesktopAttachmentMimeCompatible(mimeType, blobMimeType)).toBe(
        true,
      );
    },
  );

  it.each([
    {
      label: "image",
      suffix: "31",
      type: "image",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      kind: "image",
    },
    {
      label: "audio",
      suffix: "32",
      type: "audio",
      fileName: "clip.m4a",
      mimeType: "audio/mp4",
      kind: "audio",
    },
    {
      label: "voice",
      suffix: "33",
      type: "voice",
      fileName: "voice.m4a",
      mimeType: "audio/mp4",
      kind: "audio",
    },
    {
      label: "video",
      suffix: "34",
      type: "video",
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      kind: "video",
    },
  ] as const)(
    "downloads $label through the exact descendant loader from the live client shape",
    async ({ suffix, type, fileName, mimeType, kind }) => {
      class FixtureNode {
        id = "";
        innerText = "";
        attributes = new Map<string, string>();
        descendants: FixtureNode[] = [];

        getAttribute(name: string) {
          return this.attributes.get(name) ?? null;
        }

        closest(selector: string) {
          return selector === ".chat-message-row--opponent" ? this : null;
        }

        querySelector(selector: string) {
          if (selector === ".chat-message__text") {
            return { innerText: this.innerText };
          }
          return null;
        }

        querySelectorAll(selector: string) {
          return selector === "*" ? this.descendants : [];
        }
      }

      const messageId = `00000000-0000-4000-8000-0000000000${suffix}`;
      const attachmentMessageId = `10000000-0000-4000-8000-0000000000${suffix}`;
      const senderId = "00000000-0000-4000-8000-000000000099";
      const chatId = "00000000-0000-4000-8000-000000000088";
      const bytes = new TextEncoder().encode(`${type}-${suffix}`);
      const filePayload: {
        type: string;
        fileId: string;
        fileName: string;
        fileSize: number;
        fileMimeType: string;
        fileBlob?: string;
      } = {
        type,
        fileId: messageId,
        fileName,
        fileSize: bytes.length,
        fileMimeType: mimeType,
      };
      const envelopeFilePayload = {
        ...filePayload,
        ...(type === "voice" ? { fileBlob: "blob:file:stale-envelope" } : {}),
      };
      const envelopeMessage = {
        syncId: messageId,
        sender: { userHuid: senderId },
        payload: {
          type,
          msgId: messageId,
          from: senderId,
          payload: envelopeFilePayload,
        },
      };
      const attachmentMessage = {
        type,
        syncId: messageId,
        msgId: attachmentMessageId,
        payload: filePayload,
      };
      const downloadedFilePayload = { ...filePayload };
      const downloadedAttachmentMessage = {
        ...attachmentMessage,
        payload: downloadedFilePayload,
      };
      const loadedMessages: unknown[] = [];
      const exactLoader = ({
        message,
        downloadToBlob,
      }: {
        message: typeof attachmentMessage;
        downloadToBlob: boolean;
      }) => {
        loadedMessages.push(message);
        if (downloadToBlob) {
          downloadedFilePayload.fileBlob = `blob:file:${suffix}`;
        }
      };
      const wrongEnvelopeLoader = ({ message }: { message: unknown }) => {
        throw new Error(`wrong envelope loader selected: ${String(message)}`);
      };

      const messageNode = new FixtureNode();
      messageNode.id = messageId;
      messageNode.attributes.set("data-message-type", type);
      Object.defineProperty(messageNode, "__reactFiber$fixture", {
        value: {
          memoizedProps: {
            message: envelopeMessage,
            loadAttachment: wrongEnvelopeLoader,
          },
          return: null,
        },
      });
      const attachmentEntry = new FixtureNode();
      Object.defineProperty(attachmentEntry, "__reactFiber$fixture", {
        value: {
          elementType: { name: "MessageEntryBody" },
          memoizedProps: {
            message: attachmentMessage,
            loadAttachment: exactLoader,
          },
          alternate: {
            elementType: { name: "MessageEntryBody" },
            memoizedProps: {
              message: downloadedAttachmentMessage,
              loadAttachment: exactLoader,
            },
            return: null,
          },
          return: null,
        },
      });
      const typedEntry = new FixtureNode();
      Object.defineProperty(typedEntry, "__reactFiber$fixture", {
        value: {
          elementType: {
            name: `MessageEntry${type[0]?.toUpperCase()}${type.slice(1)}`,
          },
          memoizedProps: { message: attachmentMessage },
          return: null,
        },
      });
      messageNode.descendants = [typedEntry, attachmentEntry];

      const chatRoot = new FixtureNode();
      Object.defineProperty(chatRoot, "__reactFiber$fixture", {
        value: { memoizedProps: { groupChatId: chatId }, return: null },
      });
      const titleNode = new FixtureNode();
      titleNode.innerText = "Approved chat";
      const documentFixture = {
        getElementById: (id: string) => (id === messageId ? messageNode : null),
        querySelector: (selector: string) => {
          if (selector === ".chat") return chatRoot;
          if (selector === ".chat-header-title-container__text") {
            return titleNode;
          }
          if (
            selector === ".settings-button__avatar" ||
            selector === '.slate-message-input[contenteditable="true"]'
          ) {
            return new FixtureNode();
          }
          return null;
        },
        querySelectorAll: (selector: string) =>
          selector === ".chat-message-row--opponent .chat-message"
            ? [messageNode]
            : [],
      };
      const fetchFixture = (async (url: string | URL | Request) => {
        expect(String(url)).toBe(`blob:file:${suffix}`);
        return new Response(new Blob([bytes], { type: mimeType }));
      }) as typeof fetch;
      const run = <T>(expression: string) =>
        Function(
          "document",
          "Node",
          "fetch",
          `return (${expression});`,
        )(documentFixture, FixtureNode, fetchFixture) as T;

      const snapshot = run<{
        messages: Array<{
          type: string;
          attachment: { kind: string; mimeType: string };
        }>;
      }>(buildDesktopSnapshotExpression());
      expect(snapshot.messages[0]).toMatchObject({
        type,
        attachment: { kind, mimeType },
      });
      expect(
        run<string>(buildDesktopAttachmentStartExpression(messageId)),
      ).toBe("started");
      expect(loadedMessages).toEqual([attachmentMessage]);
      await expect(
        run<Promise<{ ready: boolean; size: number; mimeType: string }>>(
          buildDesktopAttachmentStatusExpression(messageId),
        ),
      ).resolves.toEqual({
        ready: true,
        size: bytes.length,
        mimeType,
      });
    },
  );

  it("accepts generic and ZIP blob MIME types for OpenXML documents", () => {
    const docx =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(isDesktopAttachmentMimeCompatible(docx, docx)).toBe(true);
    expect(
      isDesktopAttachmentMimeCompatible(docx, "application/octet-stream"),
    ).toBe(true);
    expect(isDesktopAttachmentMimeCompatible(docx, "application/zip")).toBe(
      true,
    );
    expect(isDesktopAttachmentMimeCompatible("application/pdf", null)).toBe(
      true,
    );
    expect(
      isDesktopAttachmentMimeCompatible("application/pdf", "application/zip"),
    ).toBe(false);
  });

  it("accepts safe media MIME aliases within the same major type", () => {
    expect(isDesktopAttachmentMimeCompatible("audio/m4a", "audio/mp4")).toBe(
      true,
    );
    expect(isDesktopAttachmentMimeCompatible("image/jpeg", "image/png")).toBe(
      true,
    );
    expect(isDesktopAttachmentMimeCompatible("audio/m4a", "video/mp4")).toBe(
      false,
    );
  });

  it.each([
    ["application/msword", "brief.doc"],
    ["application/vnd.ms-excel", "table.xls"],
    ["application/vnd.ms-powerpoint", "slides.ppt"],
  ])("keeps legacy Office document MIME %s on the generic path", (mimeType) => {
    expect(isDesktopAttachmentMimeCompatible(mimeType, mimeType)).toBe(true);
    expect(
      isDesktopAttachmentMimeCompatible(mimeType, "application/octet-stream"),
    ).toBe(true);
    expect(isDesktopAttachmentMimeCompatible(mimeType, "application/zip")).toBe(
      false,
    );
  });

  it("targets only the official client's exact attachment inputs", () => {
    expect(DESKTOP_DOCUMENT_INPUT_SELECTOR).toBe(
      'input[id^="document-input"][type="file"][accept="*"]',
    );
    expect(DESKTOP_IMAGE_INPUT_SELECTOR).toBe(
      'input[id^="image-input"][type="file"][accept="image/gif,image/jpeg,image/png,image/vnd.microsoft.icon,image/webp,image/bmp"]',
    );
    expect(DESKTOP_VIDEO_INPUT_SELECTOR).toBe(
      'input[id^="video-input"][type="file"][accept="video/*"]',
    );
    expect(desktopInputSelectorFor("document")).toBe(
      DESKTOP_DOCUMENT_INPUT_SELECTOR,
    );
    expect(desktopInputSelectorFor("image")).toBe(DESKTOP_IMAGE_INPUT_SELECTOR);
    expect(desktopInputSelectorFor("video")).toBe(DESKTOP_VIDEO_INPUT_SELECTOR);
  });

  it.each([
    ["document", "report.docx", 17_146],
    ["image", "preview.png", 4_308],
  ] as const)(
    "clicks the exact send control only after the %s attachment is selected",
    (kind, fileName, fileSize) => {
      let clicks = 0;
      const input = { files: [{ name: fileName, size: fileSize }] };
      const button = {
        disabled: false,
        click: () => {
          clicks += 1;
        },
      };
      const documentFixture = {
        querySelector: (selector: string) =>
          selector === desktopInputSelectorFor(kind) ? input : null,
        querySelectorAll: (selector: string) => {
          if (selector === ".message-input .input-attachment__file") {
            return [{}];
          }
          if (selector === ".message-input__actions button") return [button];
          return [];
        },
      };
      const run = (name: string = fileName, size: number = fileSize) =>
        Function(
          "document",
          `return (${buildDesktopSendFileExpression(kind, name, size)});`,
        )(documentFixture) as boolean;

      expect(run()).toBe(true);
      expect(clicks).toBe(1);
      expect(run("wrong-name")).toBe(false);
      expect(run(fileName, fileSize + 1)).toBe(false);
      expect(clicks).toBe(1);
    },
  );

  it("confirms the actual new DOCX attachment instead of an unrelated own message", () => {
    const oldId = "00000000-0000-4000-8000-000000000041";
    const unrelatedTextId = "00000000-0000-4000-8000-000000000042";
    const documentId = "00000000-0000-4000-8000-000000000043";
    const before = {
      ownMessages: [
        {
          id: oldId,
          senderId: "",
          type: "text" as const,
          text: "before",
        },
      ],
    };
    const after = {
      ownMessages: [
        ...before.ownMessages,
        {
          id: unrelatedTextId,
          senderId: "",
          type: "text" as const,
          text: "concurrent text",
        },
        {
          id: documentId,
          senderId: "",
          type: "document" as const,
          text: "",
          attachment: {
            fileId: documentId,
            fileName: "report.docx",
            fileSize: 17_146,
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            kind: "file" as const,
          },
        },
      ],
    };

    expect(
      confirmedDesktopOutboundFileMessageId(before, after, {
        path: "/tmp/report.docx",
        size: 17_146,
        kind: "document",
      }),
    ).toBe(documentId);
    expect(
      confirmedDesktopOutboundFileMessageId(before, after, {
        path: "/tmp/other.docx",
        size: 17_146,
        kind: "document",
      }),
    ).toBeNull();
  });

  it("confirms an image only when its new attachment metadata matches", () => {
    const imageId = "00000000-0000-4000-8000-000000000044";
    const before = { ownMessages: [] };
    const after = {
      ownMessages: [
        {
          id: imageId,
          senderId: "",
          type: "image" as const,
          text: "",
          attachment: {
            fileId: imageId,
            fileName: "preview.png",
            fileSize: 4_308,
            mimeType: "image/png",
            kind: "image" as const,
          },
        },
      ],
    };

    expect(
      confirmedDesktopOutboundFileMessageId(before, after, {
        path: "/tmp/preview.png",
        size: 4_308,
        kind: "image",
      }),
    ).toBe(imageId);
    expect(
      confirmedDesktopOutboundFileMessageId(before, after, {
        path: "/tmp/preview.png",
        size: 4_309,
        kind: "image",
      }),
    ).toBeNull();
  });

  it("confirms only a new own text message with the exact normalized body", () => {
    const oldId = "00000000-0000-4000-8000-000000000051";
    const deliveredId = "00000000-0000-4000-8000-000000000052";
    const before = {
      ownMessages: [
        {
          id: oldId,
          senderId: "",
          type: "text" as const,
          text: "same text",
        },
      ],
    };
    const after = {
      ownMessages: [
        ...before.ownMessages,
        {
          id: deliveredId,
          senderId: "",
          type: "text" as const,
          text: "line one\nline two",
          deliveryStatus: "sent",
        },
      ],
    };

    expect(
      confirmedDesktopOutboundTextMessageId(
        before,
        after,
        "line one\r\nline two",
      ),
    ).toBe(deliveredId);
    expect(
      confirmedDesktopOutboundTextMessageId(before, after, "same text"),
    ).toBeNull();
    expect(
      confirmedDesktopOutboundTextMessageId(before, after, "different"),
    ).toBeNull();
    expect(
      confirmedDesktopOutboundTextMessageId(
        before,
        {
          ownMessages: after.ownMessages.map((message) =>
            message.id === deliveredId
              ? { ...message, deliveryStatus: "sending" }
              : message,
          ),
        },
        "line one\nline two",
      ),
    ).toBeNull();
  });

  it("accepts bounded local regular files only inside allowed roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-test-"));
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside.docx");
    const filePath = join(allowed, "brief.docx");
    const linked = join(allowed, "linked.docx");
    await mkdir(allowed);
    await writeFile(filePath, "docx-test");
    await writeFile(outside, "outside");
    await symlink(outside, linked);

    await expect(
      validateDesktopOutboundFile(filePath, 1, [allowed]),
    ).resolves.toMatchObject({ path: filePath, size: 9, kind: "document" });
    await expect(
      validateDesktopOutboundFile(outside, 1, [allowed]),
    ).rejects.toThrow(/outside allowed roots/);
    await expect(
      validateDesktopOutboundFile(linked, 1, [allowed]),
    ).rejects.toThrow(/regular file/);

    const linkedDirectory = join(directory, "linked-directory");
    await symlink(allowed, linkedDirectory);
    await expect(
      validateDesktopOutboundFile(join(linkedDirectory, "brief.docx"), 1, [
        allowed,
      ]),
    ).rejects.toThrow(/contains a symlink/);
  });

  it("selects native image/video inputs and document fallback by extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-kind-test-"));
    const image = join(directory, "photo.png");
    const video = join(directory, "clip.mp4");
    const audio = join(directory, "voice.ogg");
    await writeFile(image, "image");
    await writeFile(video, "video");
    await writeFile(audio, "audio");

    await expect(
      validateDesktopOutboundFile(image, 1, [directory]),
    ).resolves.toMatchObject({ kind: "image" });
    await expect(
      validateDesktopOutboundFile(video, 1, [directory]),
    ).resolves.toMatchObject({ kind: "video" });
    await expect(
      validateDesktopOutboundFile(audio, 1, [directory]),
    ).resolves.toMatchObject({ kind: "document" });
  });

  it("rejects missing, non-regular, remote, and oversized media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-test-"));
    const nested = join(directory, "folder");
    const filePath = join(directory, "large.docx");
    await mkdir(nested);
    await writeFile(filePath, "too large");

    await expect(
      validateDesktopOutboundFile(join(directory, "missing.docx"), 1, [
        directory,
      ]),
    ).rejects.toThrow(/does not exist/);
    await expect(
      validateDesktopOutboundFile(nested, 1, [directory]),
    ).rejects.toThrow(/regular file/);
    await expect(
      validateDesktopOutboundFile("https://example.com/file.docx", 1, [
        directory,
      ]),
    ).rejects.toThrow(/local file/);
    await expect(
      validateDesktopOutboundFile(filePath, 0.000001, [directory]),
    ).rejects.toThrow(/exceeds/);
    await expect(
      validateDesktopOutboundFile(filePath, 101, [directory]),
    ).rejects.toThrow(/limit is invalid/);
    const credentialPath = join(directory, ".env.secrets");
    await writeFile(credentialPath, "not-a-real-secret");
    await expect(
      validateDesktopOutboundFile(credentialPath, 1, [directory]),
    ).rejects.toThrow(/credential-like/);
  });

  it("keeps both desktop outbound gates for document delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-gate-test-"));
    const switchPath = join(directory, "outbound.enabled");
    await writeFile(switchPath, "enabled\n");
    await chmod(switchPath, 0o600);
    const account = {
      mode: "desktop",
      config: {
        desktopOutboundEnabled: true,
        desktopOutboundSwitchPath: switchPath,
      },
    } as unknown as ResolvedExpressAccount;

    await expect(isDesktopOutboundUnlocked(account)).resolves.toBe(true);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: { ...account.config, desktopOutboundEnabled: false },
      }),
    ).resolves.toBe(false);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: join(directory, "missing"),
        },
      }),
    ).resolves.toBe(false);

    const linkedSwitch = join(directory, "linked.enabled");
    await symlink(switchPath, linkedSwitch);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: linkedSwitch,
        },
      }),
    ).resolves.toBe(false);

    const looseSwitch = join(directory, "loose.enabled");
    await writeFile(looseSwitch, "enabled\n", { mode: 0o644 });
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: looseSwitch,
        },
      }),
    ).resolves.toBe(false);
  });

  it("persists and reloads dedupe ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-desktop-test-"));
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 3);
    expect(await first.load()).toBe(false);
    await first.baseline(["one", "two"]);
    await first.add("three");
    await first.add("four");
    const second = new DesktopDedupeStore(statePath, 3);
    expect(await second.load()).toBe(true);
    expect(second.has("one")).toBe(false);
    expect(second.has("two")).toBe(true);
    expect(second.has("four")).toBe(true);
    const raw = JSON.parse(await readFile(statePath, "utf8")) as {
      seen: string[];
    };
    expect(raw.seen).toEqual(["two", "three", "four"]);
  });

  it("durably claims one acknowledgement across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-ack-test-"));
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 3);
    expect(await first.load()).toBe(false);
    expect(await first.claimAcknowledgement("message-one")).toBe(true);
    expect(await first.claimAcknowledgement("message-one")).toBe(false);

    const second = new DesktopDedupeStore(statePath, 3);
    expect(await second.load()).toBe(true);
    expect(second.hasAcknowledged("message-one")).toBe(true);
    expect(await second.claimAcknowledgement("message-one")).toBe(false);
    await second.add("message-one");

    const third = new DesktopDedupeStore(statePath, 3);
    expect(await third.load()).toBe(true);
    expect(third.has("message-one")).toBe(true);
    expect(third.hasAcknowledged("message-one")).toBe(false);
  });

  it("atomically persists one inbound claim across reloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-claim-test-"));
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 10);
    expect(await first.load()).toBe(false);

    const claims = await Promise.all([
      first.claimInbound("message-one"),
      first.claimInbound("message-one"),
      first.claimInbound("message-one"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const second = new DesktopDedupeStore(statePath, 10);
    expect(await second.load()).toBe(true);
    expect(second.hasInboundClaim("message-one")).toBe(true);
    expect(await second.claimInbound("message-one")).toBe(false);

    const raw = JSON.parse(await readFile(statePath, "utf8")) as {
      version: number;
      claimed: Record<string, string>;
    };
    expect(raw.version).toBe(6);
    expect(Object.keys(raw.claimed)).toEqual(["message-one"]);
    expect(raw.claimed["message-one"]).toBeTypeOf("string");

    await second.releaseInboundClaim("message-one");
    const third = new DesktopDedupeStore(statePath, 10);
    expect(await third.load()).toBe(true);
    expect(await third.claimInbound("message-one")).toBe(true);
  });

  it("serializes claims from overlapping store instances", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "express-overlap-claim-test-"),
    );
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 10);
    const reloaded = new DesktopDedupeStore(statePath, 10);
    expect(await first.load()).toBe(false);
    expect(await reloaded.load()).toBe(false);

    const claims = await Promise.all([
      first.claimInbound("message-one"),
      reloaded.claimInbound("message-one"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const persisted = new DesktopDedupeStore(statePath, 10);
    expect(await persisted.load()).toBe(true);
    expect(persisted.hasInboundClaim("message-one")).toBe(true);
  });

  it("retries old acknowledgements and claims from a previous process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-v4-claim-test-"));
    const v4StatePath = join(directory, "v4-state.json");
    await writeFile(
      v4StatePath,
      JSON.stringify({
        version: 4,
        seen: [],
        acknowledged: ["possibly-dispatched", "poison-retry"],
        failures: { "poison-retry": 1 },
        quarantined: [],
        updatedAt: new Date(0).toISOString(),
      }),
    );

    const v4Store = new DesktopDedupeStore(v4StatePath, 10);
    expect(await v4Store.load()).toBe(true);
    expect(v4Store.has("possibly-dispatched")).toBe(false);
    expect(v4Store.has("poison-retry")).toBe(false);

    const staleStatePath = join(directory, "stale-v5-state.json");
    await writeFile(
      staleStatePath,
      JSON.stringify({
        version: 5,
        seen: [],
        acknowledged: [],
        claimed: { "stale-claim": "previous-process" },
        failures: {},
        quarantined: [],
        updatedAt: new Date(0).toISOString(),
      }),
    );
    const restartedStore = new DesktopDedupeStore(staleStatePath, 10);
    expect(await restartedStore.load()).toBe(true);
    expect(restartedStore.has("stale-claim")).toBe(false);
    expect(await restartedStore.claimInbound("stale-claim")).toBe(true);
  });

  it("durably retries one failed event and quarantines only that id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-retry-test-"));
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 10);
    expect(await first.load()).toBe(false);
    expect(await first.claimAcknowledgement("poison-one")).toBe(true);
    await expect(first.recordFailure("poison-one", 3)).resolves.toEqual({
      attempt: 1,
      quarantined: false,
    });
    expect(first.has("poison-one")).toBe(false);
    expect(first.hasAcknowledged("poison-one")).toBe(true);

    const second = new DesktopDedupeStore(statePath, 10);
    expect(await second.load()).toBe(true);
    await expect(second.recordFailure("poison-one", 3)).resolves.toEqual({
      attempt: 2,
      quarantined: false,
    });
    await expect(second.recordFailure("poison-one", 3)).resolves.toEqual({
      attempt: 3,
      quarantined: true,
    });
    expect(second.has("poison-one")).toBe(true);
    expect(second.hasAcknowledged("poison-one")).toBe(false);
    expect(await second.claimAcknowledgement("poison-one")).toBe(false);

    await second.add("healthy-two");
    const raw = JSON.parse(await readFile(statePath, "utf8")) as {
      version: number;
      seen: string[];
      failures: Record<string, number>;
      quarantined: Record<string, number>;
    };
    expect(raw).toMatchObject({
      version: 6,
      seen: ["healthy-two"],
      failures: {},
    });
    expect(Object.keys(raw.quarantined)).toEqual(["poison-one"]);
    expect(raw.quarantined["poison-one"]).toBeTypeOf("number");
  });

  it("loads the previous dedupe format without replaying visible messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-state-v2-test-"));
    const statePath = join(directory, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        seen: ["legacy-seen"],
        updatedAt: new Date(0).toISOString(),
      }),
    );
    const store = new DesktopDedupeStore(statePath);
    expect(await store.load()).toBe(true);
    expect(store.has("legacy-seen")).toBe(true);
  });
});

describe("eXpress desktop idle chat-list digest", () => {
  const chatId = "00000000-0000-4000-8000-00000000aaaa";

  it("reads only the allowlisted chats", () => {
    const expression = buildDesktopChatListDigestExpression([
      chatId.toUpperCase(),
    ]);
    expect(expression).toContain(chatId);
    expect(expression).toContain(".chat-list-entry");
  });

  it("never navigates, clicks or types while observing", () => {
    const expression = buildDesktopChatListDigestExpression([chatId]);
    expect(expression).not.toContain(".click(");
    expect(expression).not.toContain("history.push");
    expect(expression).not.toContain("setInputText");
    expect(expression).not.toContain("handleSendMessage");
    // Reading body text forces a full layout pass on every poll.
    expect(expression).not.toContain("innerText");
  });
});

describe("eXpress desktop transient command faults", () => {
  it("retries a timed-out command before dropping the socket", () => {
    const timeout = new Error(
      "desktop CDP command timed out: Runtime.evaluate",
    );
    expect(isDesktopCommandTimeout(timeout)).toBe(true);
    expect(isRetryableDesktopCommandError(timeout)).toBe(true);
  });

  it("treats a closed socket as retryable but not as a timeout", () => {
    const closed = new Error("desktop CDP connection closed");
    expect(isDesktopCommandTimeout(closed)).toBe(false);
    expect(isRetryableDesktopCommandError(closed)).toBe(true);
  });

  it("does not retry a rejected evaluation", () => {
    expect(
      isRetryableDesktopCommandError(
        new Error("desktop CDP evaluation raised an exception"),
      ),
    ).toBe(false);
  });
});

describe("eXpress desktop UI lock modes", () => {
  it("keeps a read-only section out of the cross-process lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-lock-mode-"));
    const lockPath = join(directory, "ui.lock");
    const mutex = new DesktopUiMutex(lockPath, 1_000);
    let observed: string | null = null;
    await mutex.runLocal(async () => {
      observed = await readFile(lockPath, "utf8").catch(() => null);
    });
    expect(observed).toBeNull();
  });

  it("takes the cross-process lease for UI-mutating work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-lock-mode-"));
    const lockPath = join(directory, "ui.lock");
    const mutex = new DesktopUiMutex(lockPath, 1_000);
    let observed: string | null = null;
    await mutex.runExclusive(async () => {
      observed = await readFile(lockPath, "utf8").catch(() => null);
    });
    expect(observed).toContain('"pid"');
  });

  it("refuses to escalate a read-only section into a UI mutation", async () => {
    const mutex = new DesktopUiMutex();
    await expect(
      mutex.runLocal(async () => mutex.runExclusive(async () => "unsafe")),
    ).rejects.toThrow(/cannot escalate/);
  });
});

describe("eXpress desktop quarantine ageing", () => {
  it("stops reporting an expired quarantine while still suppressing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-quarantine-ttl-"));
    const statePath = join(directory, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 5,
        seen: [],
        acknowledged: [],
        claimed: {},
        failures: {},
        quarantined: ["stale-one"],
        updatedAt: new Date(
          Date.now() - DESKTOP_QUARANTINE_TTL_MS - 60_000,
        ).toISOString(),
      }),
      { mode: 0o600 },
    );
    const store = new DesktopDedupeStore(statePath);
    expect(await store.load()).toBe(true);
    const health = await store.healthSnapshot();
    expect(health.quarantined).toBe(0);
    // Still suppressed: an aged incident must never be replayed to the model.
    expect(store.has("stale-one")).toBe(true);
    expect(await store.claimInbound("stale-one")).toBe(false);
  });

  it("keeps a recent quarantine visible to the watchdog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-quarantine-ttl-"));
    const statePath = join(directory, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 6,
        seen: [],
        acknowledged: [],
        claimed: {},
        failures: {},
        quarantined: { "fresh-one": Date.now() - 1_000 },
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const store = new DesktopDedupeStore(statePath);
    expect(await store.load()).toBe(true);
    const health = await store.healthSnapshot();
    expect(health.quarantined).toBe(1);
    expect(store.has("fresh-one")).toBe(true);
  });
});
