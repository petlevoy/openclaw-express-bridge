/**
 * Tests for send helpers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendExpressMediaMessage, sendExpressMessage } from "./send.js";

const mocks = vi.hoisted(() => ({
  account: {
    accountId: "default",
    configured: true,
    botId: "bot-id",
    secretKey: "secret",
    ctsUrl: "https://cts.test.com",
    webhookPort: 18790,
    enabled: true,
    mode: "botx" as "botx" | "desktop",
    config: {},
  },
  sendDesktopFile: vi.fn().mockResolvedValue("desktop-file-id"),
  sendDesktopMessage: vi.fn().mockResolvedValue("desktop-text-id"),
  validateDesktopFile: vi.fn().mockResolvedValue({
    path: "/tmp/brief.docx",
    size: 42,
    kind: "document" as const,
  }),
}));

// Mock the api module
vi.mock("./api.js", () => ({
  sendMessageWithRefresh: vi.fn().mockResolvedValue("sync-id-123"),
  getCachedToken: vi.fn().mockResolvedValue("token"),
  getToken: vi.fn().mockResolvedValue("token"),
  invalidateToken: vi.fn(),
  downloadFile: vi.fn(),
  BotXApiError: class BotXApiError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

// Mock accounts module
vi.mock("./accounts.js", () => ({
  resolveExpressAccount: vi.fn(() => mocks.account),
}));

vi.mock("./desktop-cdp.js", () => ({
  DEFAULT_DESKTOP_MEDIA_MAX_MB: 20,
  sendExpressDesktopFile: mocks.sendDesktopFile,
  sendExpressDesktopMessage: mocks.sendDesktopMessage,
  validateDesktopOutboundFile: mocks.validateDesktopFile,
}));

describe("Send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.account.mode = "botx";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should send message and return messageId", async () => {
    const result = await sendExpressMessage("chat-uuid-1", "Hello", {
      cfg: { channels: {} } as never,
    });
    expect(result.messageId).toBe("sync-id-123");
  });

  it("should strip express: prefix from target", async () => {
    const { sendMessageWithRefresh } = await import("./api.js");
    await sendExpressMessage("express:chat-uuid-2", "Hello", {
      cfg: { channels: {} } as never,
    });
    expect(sendMessageWithRefresh).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "chat-uuid-2", // stripped
      "Hello",
    );
  });

  it("normalizes outbound Markdown to eXpress-safe plain text", async () => {
    await sendExpressMessage(
      "chat-id",
      "**Report** [source](https://example.com)",
      {
        cfg: { channels: {} } as never,
      },
    );
    const api = await import("./api.js");
    expect(api.sendMessageWithRefresh).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "chat-id",
      "Report source (https://example.com)",
    );
  });

  it("should return empty messageId for empty text", async () => {
    const result = await sendExpressMessage("chat-uuid", "", {
      cfg: { channels: {} } as never,
    });
    expect(result.messageId).toBe("");
  });

  it("should return empty messageId for whitespace-only text", async () => {
    const result = await sendExpressMessage("chat-uuid", "   ", {
      cfg: { channels: {} } as never,
    });
    expect(result.messageId).toBe("");
  });

  it("sends an actual local document through desktop mode", async () => {
    mocks.account.mode = "desktop";
    const result = await sendExpressMediaMessage(
      "express:00000000-0000-4000-8000-000000000001",
      "",
      "/tmp/brief.docx",
      { cfg: { channels: {} } as never },
    );

    expect(result.messageId).toBe("desktop-file-id");
    expect(mocks.validateDesktopFile).toHaveBeenCalledWith(
      "/tmp/brief.docx",
      20,
      undefined,
    );
    expect(mocks.sendDesktopFile).toHaveBeenCalledWith(
      mocks.account,
      "00000000-0000-4000-8000-000000000001",
      "/tmp/brief.docx",
    );
  });

  it("sends a desktop caption before the attached file", async () => {
    mocks.account.mode = "desktop";
    await sendExpressMediaMessage(
      "chat-id",
      " **caption** ",
      "/tmp/brief.docx",
      {
        cfg: { channels: {} } as never,
      },
    );
    expect(mocks.sendDesktopMessage).toHaveBeenCalledWith(
      mocks.account,
      "chat-id",
      "caption",
    );
    expect(mocks.validateDesktopFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendDesktopMessage.mock.invocationCallOrder[0],
    );
    expect(mocks.sendDesktopFile).toHaveBeenCalledOnce();
  });

  it("fails closed instead of pretending BotX uploaded a file", async () => {
    await expect(
      sendExpressMediaMessage("chat-id", "", "/tmp/brief.docx", {
        cfg: { channels: {} } as never,
      }),
    ).rejects.toThrow(/BotX outbound file upload is not supported/);
  });
});
