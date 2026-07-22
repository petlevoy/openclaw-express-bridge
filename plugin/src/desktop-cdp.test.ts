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

import { describe, expect, it } from "vitest";

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  buildDesktopAttachmentChunkExpression,
  buildDesktopAttachmentStartExpression,
  buildDesktopAttachmentStatusExpression,
  buildDesktopSnapshotExpression,
  buildDesktopTypingExpression,
  DESKTOP_DOCUMENT_INPUT_SELECTOR,
  DESKTOP_IMAGE_INPUT_SELECTOR,
  DESKTOP_VIDEO_INPUT_SELECTOR,
  DesktopDedupeStore,
  desktopInputSelectorFor,
  isDesktopAttachmentMimeCompatible,
  isDesktopOutboundUnlocked,
  normalizeLoopbackCdpSocketUrl,
  normalizeLoopbackCdpUrl,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";

describe("eXpress desktop CDP bridge", () => {
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
    titleNode.innerText = "Petlevoy Vitaly\nstatus";
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
    }>(buildDesktopSnapshotExpression());
    expect(snapshot).toMatchObject({
      chatId,
      chatTitle: "Petlevoy Vitaly",
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
        msgId: messageId,
        payload: filePayload,
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
        if (downloadToBlob) filePayload.fileBlob = `blob:file:${suffix}`;
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
      quarantined: string[];
    };
    expect(raw).toMatchObject({
      version: 4,
      seen: ["healthy-two"],
      failures: {},
      quarantined: ["poison-one"],
    });
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
