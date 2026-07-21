/**
 * Tests for send helpers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendExpressMessage } from "./send.js";

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
  resolveExpressAccount: vi.fn().mockReturnValue({
    accountId: "default",
    configured: true,
    botId: "bot-id",
    secretKey: "secret",
    ctsUrl: "https://cts.test.com",
    webhookPort: 18790,
    enabled: true,
    config: {},
  }),
}));

describe("Send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
