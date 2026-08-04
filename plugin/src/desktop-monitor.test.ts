import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import { DesktopDedupeStore, type DesktopMessage } from "./desktop-cdp.js";
import {
  createDesktopSourceReplyOptions,
  DesktopActiveSessionRegistry,
  DesktopInboundAttachmentError,
  DesktopInboundReplyDeliveryError,
  desktopPollSliceMs,
  DesktopReplyDeliveryTracker,
  desktopStatePathForChat,
  isDesktopPriorityAbortMessage,
  processDesktopInboundEvent,
  resolveDesktopDurableTextDelivery,
  selectDesktopDueChats,
  validateDesktopExactAllowlist,
  validateDesktopExactPeerRoutes,
} from "./desktop-monitor.js";

const senderId = "00000000-0000-4000-8000-000000000099";
const message = (suffix: string, type: DesktopMessage["type"] = "document") =>
  ({
    id: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    senderId,
    type,
    text: "",
  }) satisfies DesktopMessage;

describe("desktop inbound event isolation", () => {
  it("delivers ordinary source replies through the desktop callback", () => {
    const onModelSelected = vi.fn();
    expect(createDesktopSourceReplyOptions(onModelSelected)).toEqual({
      onModelSelected,
      sourceReplyDeliveryMode: "automatic",
    });
  });

  it("requires a confirmed final before completing an ordinary inbound", () => {
    const tracker = new DesktopReplyDeliveryTracker();
    tracker.observe("tool", { visibleReplySent: true });
    tracker.observe("final", { visibleReplySent: false });
    expect(() => tracker.assertFinalVisible(true)).toThrow(
      DesktopInboundReplyDeliveryError,
    );

    tracker.observe("final", {});
    expect(() => tracker.assertFinalVisible(true)).not.toThrow();
  });

  it("requires exact peer bindings and resolves a distinct session per chat", () => {
    const chats = [
      {
        chatId: "00000000-0000-4000-8000-000000000001",
        chatTitle: "Alice",
        senderId: "00000000-0000-4000-8000-000000000011",
      },
      {
        chatId: "00000000-0000-4000-8000-000000000002",
        chatTitle: "Bob",
        senderId: "00000000-0000-4000-8000-000000000022",
      },
    ];
    const exactConfig = {
      agents: { list: [{ id: "main" }, { id: "express" }] },
      session: { dmScope: "per-channel-peer" as const },
      bindings: chats.map((chat) => ({
        type: "route" as const,
        agentId: "express",
        match: {
          channel: "express",
          accountId: "default",
          peer: { kind: "direct" as const, id: chat.senderId },
        },
      })),
    } as OpenClawConfig;
    const routes = validateDesktopExactPeerRoutes(
      exactConfig,
      "default",
      chats,
    );
    expect(routes.map((route) => route.matchedBy)).toEqual([
      "binding.peer",
      "binding.peer",
    ]);
    expect(new Set(routes.map((route) => route.sessionKey)).size).toBe(2);

    const wildcardConfig = {
      agents: exactConfig.agents,
      bindings: [
        {
          type: "route" as const,
          agentId: "express",
          match: { channel: "express", accountId: "default" },
        },
      ],
    } as OpenClawConfig;
    expect(() =>
      validateDesktopExactPeerRoutes(wildcardConfig, "default", chats),
    ).toThrow(/exact direct peer binding/);
  });

  it("bounds multi-chat UI switching without slowing a single chat", () => {
    expect(desktopPollSliceMs(250, 1)).toBe(250);
    expect(desktopPollSliceMs(1_000, 3)).toBe(1_000);
    expect(desktopPollSliceMs(6_000, 3)).toBe(2_000);
  });

  it("routes final text through durable delivery and leaves media on fallback", () => {
    const chatId = "00000000-0000-4000-8000-000000000001";
    expect(
      resolveDesktopDurableTextDelivery(chatId, { text: "reply" }, "final"),
    ).toEqual({
      to: `express:${chatId}`,
      requiredCapabilities: {
        text: true,
        reconcileUnknownSend: true,
      },
    });
    expect(
      resolveDesktopDurableTextDelivery(
        chatId,
        { text: "caption", mediaUrl: "/tmp/file.pdf" },
        "final",
      ),
    ).toBe(false);
    expect(
      resolveDesktopDurableTextDelivery(chatId, { text: "progress" }, "tool"),
    ).toBe(false);
  });

  it("recognizes only standalone text abort commands as priority events", () => {
    expect(
      isDesktopPriorityAbortMessage({
        ...message("10", "text"),
        text: "стоп",
      }),
    ).toBe(true);
    expect(
      isDesktopPriorityAbortMessage({
        ...message("11", "text"),
        text: "/stop",
      }),
    ).toBe(true);
    expect(
      isDesktopPriorityAbortMessage({
        ...message("12", "text"),
        text: "стоп, потом продолжай",
      }),
    ).toBe(false);
    expect(
      isDesktopPriorityAbortMessage({
        ...message("13", "document"),
        text: "стоп",
        attachment: {
          fileId: "00000000-0000-4000-8000-000000000013",
          fileName: "stop.pdf",
          fileSize: 10,
          mimeType: "application/pdf",
          kind: "file",
        },
      }),
    ).toBe(false);
  });

  it("aborts each active session once when the monitor stops", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const aborted: string[] = [];
    const registry = new DesktopActiveSessionRegistry(async (sessionKey) => {
      aborted.push(sessionKey);
    });
    const first = registry.run("agent:test:express:direct:user", () => gate);
    const second = registry.run("agent:test:express:direct:user", () => gate);

    await registry.abortAll();
    await registry.abortAll();
    expect(aborted).toEqual(["agent:test:express:direct:user"]);
    await expect(
      registry.run("agent:test:express:direct:other", async () => {}),
    ).rejects.toThrow("monitor stopped");

    release();
    await Promise.all([first, second]);
  });

  it("separates durable state by chat without changing the legacy path", () => {
    const base = "/tmp/express-state.json";
    expect(desktopStatePathForChat(base, "default", "chat-a", false)).toBe(
      base,
    );
    expect(desktopStatePathForChat(base, "default", "chat-a", true)).toBe(
      "/tmp/express-state.chat-a.json",
    );
    expect(desktopStatePathForChat(base, "default", "chat-b", true)).toBe(
      "/tmp/express-state.chat-b.json",
    );
  });

  it("requires an exact fail-closed chat and sender allowlist", () => {
    const chats = [
      {
        chatId: "00000000-0000-4000-8000-000000000001",
        chatTitle: "Alice",
        senderId: "00000000-0000-4000-8000-000000000011",
      },
      {
        chatId: "00000000-0000-4000-8000-000000000002",
        chatTitle: "Bob",
        senderId: "00000000-0000-4000-8000-000000000022",
      },
    ];
    expect(() =>
      validateDesktopExactAllowlist(chats, [
        chats[0].chatId,
        chats[0].senderId,
        chats[1].chatId,
        chats[1].senderId,
      ]),
    ).not.toThrow();
    expect(() =>
      validateDesktopExactAllowlist(chats, [
        chats[0].chatId,
        chats[0].senderId,
      ]),
    ).toThrow(/exactly match/);
    expect(() =>
      validateDesktopExactAllowlist(chats, [
        chats[0].chatId,
        chats[0].senderId,
        chats[1].chatId,
        chats[1].senderId,
        "00000000-0000-4000-8000-000000000099",
      ]),
    ).toThrow(/exactly match/);
  });

  it("does not reconnect for one attachment failure and continues the batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-event-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const poison = message("1", "voice");
    const healthy = message("2", "text");
    const diagnostics: string[] = [];

    await expect(
      processDesktopInboundEvent({
        message: poison,
        store,
        work: async () => {
          throw new DesktopInboundAttachmentError(
            new Error("desktop inbound attachment was not loaded"),
          );
        },
        onDiagnostic: (outcome, attempt, diagnostic) =>
          diagnostics.push(`${outcome}:${attempt}:${diagnostic}`),
      }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({
        message: healthy,
        store,
        work: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe("delivered");

    expect(store.has(poison.id)).toBe(false);
    expect(store.has(healthy.id)).toBe(true);
    expect(diagnostics).toEqual([
      "retry:1:desktop inbound attachment was not loaded",
    ]);
  });

  it("quarantines a poison id after bounded retries without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-poison-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const poison = message("3", "audio");
    const work = async () => {
      throw new DesktopInboundAttachmentError(new Error("invalid audio blob"));
    };

    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("quarantined");
    expect(store.has(poison.id)).toBe(true);
  });

  it("bounds repeated invisible finals instead of spending tokens forever", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-private-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const inbound = message("30", "text");
    const work = async () => {
      throw new DesktopInboundReplyDeliveryError("no visible final");
    };

    await expect(
      processDesktopInboundEvent({ message: inbound, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: inbound, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: inbound, store, work }),
    ).resolves.toBe("quarantined");
    expect(store.has(inbound.id)).toBe(true);
  });

  it("still reconnects on transport or OpenClaw dispatch failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-global-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const inbound = message("4");

    await expect(
      processDesktopInboundEvent({
        message: inbound,
        store,
        work: async () => {
          throw new Error("desktop CDP connection closed");
        },
      }),
    ).rejects.toThrow("desktop CDP connection closed");
    expect(store.has(inbound.id)).toBe(false);
  });

  it("completes a durable inbound claim after successful dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-claim-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const inbound = message("5", "text");

    await expect(store.claimInbound(inbound.id)).resolves.toBe(true);
    expect(store.hasInboundClaim(inbound.id)).toBe(true);
    await expect(
      processDesktopInboundEvent({
        message: inbound,
        store,
        work: async () => {},
      }),
    ).resolves.toBe("delivered");
    expect(store.has(inbound.id)).toBe(true);
    expect(store.hasInboundClaim(inbound.id)).toBe(false);
  });
});

describe("desktop idle chat-list watch", () => {
  const chatId = "00000000-0000-4000-8000-00000000aaaa";
  const otherChatId = "00000000-0000-4000-8000-00000000bbbb";
  const runtime = (overrides: Partial<Runtime> = {}): Runtime => ({
    chat: { chatId },
    needsBaseline: false,
    lastEventSyncId: "sync-one",
    lastFullCheckAt: 1_000,
    ...overrides,
  });
  type Runtime = {
    chat: { chatId: string };
    needsBaseline: boolean;
    lastEventSyncId?: string | null;
    lastFullCheckAt: number;
  };
  const digest = (
    entries: Array<{
      chatId: string;
      lastEventSyncId: string | null;
      unreadCounter?: number;
      mentionCounter?: number;
    }>,
  ) => ({
    authenticated: true,
    chatListReady: true,
    entries: entries.map((entry) => ({
      unreadCounter: 0,
      mentionCounter: 0,
      lastEventSenderId: null,
      ...entry,
    })),
  });
  const select = (runtimes: Runtime[], list: ReturnType<typeof digest>) =>
    selectDesktopDueChats({
      runtimes,
      digest: list,
      now: 2_000,
      fullSweepIntervalMs: 300_000,
    });

  it("leaves an unchanged chat closed so the client stays idle", () => {
    const due = select(
      [runtime()],
      digest([{ chatId, lastEventSyncId: "sync-one" }]),
    );
    expect(due).toEqual([]);
  });

  it("opens a chat whose last event changed", () => {
    const due = select(
      [runtime()],
      digest([{ chatId, lastEventSyncId: "sync-two" }]),
    );
    expect(due).toHaveLength(1);
  });

  it("opens a chat with unread or mentioned traffic", () => {
    expect(
      select(
        [runtime()],
        digest([{ chatId, lastEventSyncId: "sync-one", unreadCounter: 1 }]),
      ),
    ).toHaveLength(1);
    expect(
      select(
        [runtime()],
        digest([{ chatId, lastEventSyncId: "sync-one", mentionCounter: 1 }]),
      ),
    ).toHaveLength(1);
  });

  it("treats a chat the list does not describe as unknown, never as quiet", () => {
    const due = select(
      [runtime()],
      digest([{ chatId: otherChatId, lastEventSyncId: "sync-one" }]),
    );
    expect(due).toHaveLength(1);
  });

  it("still sweeps every chat on the configured interval", () => {
    const due = selectDesktopDueChats({
      runtimes: [runtime({ lastFullCheckAt: 0 })],
      digest: digest([{ chatId, lastEventSyncId: "sync-one" }]),
      now: 400_000,
      fullSweepIntervalMs: 300_000,
    });
    expect(due).toHaveLength(1);
  });

  it("always opens a chat that still needs its baseline", () => {
    const due = select(
      [runtime({ needsBaseline: true })],
      digest([{ chatId, lastEventSyncId: "sync-one" }]),
    );
    expect(due).toHaveLength(1);
  });

  it("reports a first observation as due before any marker is recorded", () => {
    const due = select(
      [runtime({ lastEventSyncId: undefined })],
      digest([{ chatId, lastEventSyncId: "sync-one" }]),
    );
    expect(due).toHaveLength(1);
  });
});
