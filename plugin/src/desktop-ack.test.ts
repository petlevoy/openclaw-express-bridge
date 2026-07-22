import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  startDesktopInboundAcknowledgement,
  withDesktopInboundAcknowledgement,
} from "./desktop-ack.js";

const chatId = "00000000-0000-4000-8000-000000000088";

function account(
  desktopAckMode: "off" | "typing" | "message" | undefined,
): ResolvedExpressAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    mode: "desktop",
    botId: "",
    secretKey: "",
    ctsUrl: "",
    webhookPort: 18790,
    config: {
      mode: "desktop",
      desktopAckMode,
      desktopAckText: "  Взял   в работу  ",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop inbound acknowledgement", () => {
  it("is disabled by default and performs no outbound action", async () => {
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn(),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account(undefined),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
    });
    expect(handle.kind).toBe("none");
    expect(client.sendText).not.toHaveBeenCalled();
    expect(client.setTyping).not.toHaveBeenCalled();
  });

  it("sends one normalized message acknowledgement when configured", async () => {
    const client = {
      sendText: vi.fn().mockResolvedValue("ack-id"),
      setTyping: vi.fn(),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account("message"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
    });
    expect(handle.kind).toBe("message");
    expect(client.sendText).toHaveBeenCalledOnce();
    expect(client.sendText).toHaveBeenCalledWith(chatId, "Взял в работу");
  });

  it("claims an inbound id before sending and suppresses a duplicate", async () => {
    const claimed = new Set<string>();
    const claim = async () => {
      if (claimed.has("message-1")) return false;
      claimed.add("message-1");
      return true;
    };
    const client = {
      sendText: vi.fn().mockResolvedValue("ack-id"),
      setTyping: vi.fn(),
    };
    const options = {
      account: account("message"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
      claim,
    };

    expect((await startDesktopInboundAcknowledgement(options)).kind).toBe(
      "message",
    );
    expect((await startDesktopInboundAcknowledgement(options)).kind).toBe(
      "none",
    );
    expect(client.sendText).toHaveBeenCalledOnce();
  });

  it("starts acknowledgement before work and stops it after work", async () => {
    const events: string[] = [];
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn(async (_target: string, active: boolean) => {
        events.push(active ? "start" : "stop");
      }),
    };

    await withDesktopInboundAcknowledgement(
      {
        account: account("typing"),
        client,
        targetChatId: chatId,
        isUnlocked: async () => true,
      },
      async () => {
        events.push("work");
      },
    );

    expect(events).toEqual(["start", "work", "stop"]);
  });

  it("keeps native typing alive and explicitly stops it", async () => {
    vi.useFakeTimers();
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account("typing"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
      keepaliveMs: 250,
    });
    expect(handle.kind).toBe("typing");
    expect(client.setTyping).toHaveBeenNthCalledWith(1, chatId, true);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.setTyping).toHaveBeenNthCalledWith(2, chatId, true);
    await handle.stop();
    expect(client.setTyping).toHaveBeenLastCalledWith(chatId, false);
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("falls back to text when the verified native action is unavailable", async () => {
    const errors: string[] = [];
    const client = {
      sendText: vi.fn().mockResolvedValue("ack-id"),
      setTyping: vi
        .fn()
        .mockRejectedValue(
          new Error("desktop native typing action is unavailable"),
        ),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account("typing"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
      onError: (kind) => errors.push(kind),
    });
    expect(handle.kind).toBe("message");
    expect(client.setTyping).toHaveBeenCalledWith(chatId, true);
    expect(client.sendText).toHaveBeenCalledWith(chatId, "Взял в работу");
    expect(errors).toEqual(["typing"]);
  });

  it("does not risk a duplicate text signal after an ambiguous typing error", async () => {
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn().mockRejectedValue(new Error("CDP response lost")),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account("typing"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => true,
    });
    expect(handle.kind).toBe("none");
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("keeps acknowledgement failure fail-soft for inbound work", async () => {
    const events: string[] = [];
    await expect(
      withDesktopInboundAcknowledgement(
        {
          account: account("message"),
          client: {
            sendText: vi.fn().mockRejectedValue(new Error("send failed")),
            setTyping: vi.fn(),
          },
          targetChatId: chatId,
          isUnlocked: async () => true,
        },
        async () => {
          events.push("work");
        },
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["work"]);
  });

  it("never bypasses a locked outbound interlock", async () => {
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn(),
    };
    const handle = await startDesktopInboundAcknowledgement({
      account: account("typing"),
      client,
      targetChatId: chatId,
      isUnlocked: async () => false,
    });
    expect(handle.kind).toBe("none");
    expect(client.setTyping).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("re-checks the interlock after a durable claim before typing", async () => {
    const client = {
      sendText: vi.fn(),
      setTyping: vi.fn(),
    };
    const isUnlocked = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const claim = vi.fn().mockResolvedValue(true);
    const handle = await startDesktopInboundAcknowledgement({
      account: account("typing"),
      client,
      targetChatId: chatId,
      claim,
      isUnlocked,
    });
    expect(handle.kind).toBe("none");
    expect(claim).toHaveBeenCalledOnce();
    expect(isUnlocked).toHaveBeenCalledTimes(2);
    expect(client.setTyping).not.toHaveBeenCalled();
  });
});
