/**
 * Tests for BotX API client
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BotXApiError,
  getCachedToken,
  getToken,
  invalidateToken,
  sendMessage,
  UnauthorizedError,
} from "./api.js";

const MOCK_CTS = "https://cts.test.com";
const MOCK_BOT_ID = "bot-123";
const MOCK_SECRET = "secret-key";
const MOCK_ACCOUNT = "default";

describe("BotX API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateToken(MOCK_ACCOUNT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getToken", () => {
    it("should fetch JWT token successfully", async () => {
      const mockResponse = {
        result: "jwt-token-abc",
        status: "ok",
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Map(),
        text: async () => "",
      });

      const token = await getToken(MOCK_CTS, MOCK_BOT_ID, MOCK_SECRET);
      expect(token).toBe("jwt-token-abc");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v3/botx/bots/${MOCK_BOT_ID}/token`),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret_key: MOCK_SECRET }),
        }),
      );
    });

    it("should throw BotXApiError on non-ok response", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
        headers: new Map(),
        text: async () => "Forbidden",
      });

      await expect(
        getToken(MOCK_CTS, MOCK_BOT_ID, MOCK_SECRET),
      ).rejects.toThrow(BotXApiError);
    });

    it("should throw on error status in response body", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: "",
          status: "error",
          errors: ["bad key"],
        }),
        headers: new Map(),
        text: async () => "",
      });

      await expect(
        getToken(MOCK_CTS, MOCK_BOT_ID, MOCK_SECRET),
      ).rejects.toThrow(BotXApiError);
    });
  });

  describe("getCachedToken", () => {
    it("should cache token and reuse it", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: "cached-token", status: "ok" }),
        headers: new Map(),
        text: async () => "",
      });

      const t1 = await getCachedToken(
        MOCK_CTS,
        MOCK_BOT_ID,
        MOCK_SECRET,
        MOCK_ACCOUNT,
      );
      expect(t1).toBe("cached-token");

      // Second call should use cache (no new fetch)
      const t2 = await getCachedToken(
        MOCK_CTS,
        MOCK_BOT_ID,
        MOCK_SECRET,
        MOCK_ACCOUNT,
      );
      expect(t2).toBe("cached-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should fetch new token after invalidation", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ result: "token-1", status: "ok" }),
          headers: new Map(),
          text: async () => "",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ result: "token-2", status: "ok" }),
          headers: new Map(),
          text: async () => "",
        });

      const t1 = await getCachedToken(
        MOCK_CTS,
        MOCK_BOT_ID,
        MOCK_SECRET,
        MOCK_ACCOUNT,
      );
      expect(t1).toBe("token-1");

      invalidateToken(MOCK_ACCOUNT);

      const t2 = await getCachedToken(
        MOCK_CTS,
        MOCK_BOT_ID,
        MOCK_SECRET,
        MOCK_ACCOUNT,
      );
      expect(t2).toBe("token-2");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("sendMessage", () => {
    it("should send message and return sync_id", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", result: { sync_id: "sync-789" } }),
        headers: new Map(),
        text: async () => "",
      });

      const syncId = await sendMessage(
        MOCK_CTS,
        "jwt-token",
        "chat-uuid",
        "Hello!",
      );
      expect(syncId).toBe("sync-789");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v3/botx/notifications/direct"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer jwt-token",
          }),
        }),
      );
    });

    it("should throw UnauthorizedError on 401", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
        headers: new Map(),
        text: async () => "Unauthorized",
      });

      await expect(
        sendMessage(MOCK_CTS, "bad-token", "chat-uuid", "Hello"),
      ).rejects.toThrow(UnauthorizedError);
    });

    it("should throw BotXApiError on other errors", async () => {
      // fetchWithRetry retries on 5xx with exponential backoff (1s, 2s, 4s)
      // Use 400 to avoid retry delays
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({}),
        headers: new Map(),
        text: async () => "Bad Request",
      });

      await expect(
        sendMessage(MOCK_CTS, "token", "chat-uuid", "Hello"),
      ).rejects.toThrow(BotXApiError);
    });
  });
});
