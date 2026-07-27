/**
 * Tests for config schema
 */

import { describe, expect, it } from "vitest";

import { ExpressAccountSchema, ExpressConfigSchema } from "./config-schema.js";

describe("Config Schema", () => {
  describe("ExpressAccountSchema", () => {
    it("should accept valid account config", () => {
      const valid = {
        botId: "bot-uuid",
        secretKey: "secret",
        ctsUrl: "https://cts.example.com",
        webhookPort: 18790,
      };
      const result = ExpressAccountSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("should accept minimal config", () => {
      const minimal = {};
      const result = ExpressAccountSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    it("should reject unknown keys", () => {
      const invalid = { botId: "bot", unknownField: true };
      const result = ExpressAccountSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("should accept dmPolicy values", () => {
      for (const policy of ["pairing", "allowlist", "disabled"]) {
        const result = ExpressAccountSchema.safeParse({ dmPolicy: policy });
        expect(result.success).toBe(true);
      }
    });

    it("should require allowFrom for open dmPolicy", () => {
      const result = ExpressAccountSchema.safeParse({ dmPolicy: "open" });
      expect(result.success).toBe(false);

      const withAllow = ExpressAccountSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["*"],
      });
      expect(withAllow.success).toBe(true);
    });

    it("should accept streamMode values", () => {
      for (const mode of ["off", "partial", "block"]) {
        const result = ExpressAccountSchema.safeParse({ streamMode: mode });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid streamMode", () => {
      const result = ExpressAccountSchema.safeParse({ streamMode: "invalid" });
      expect(result.success).toBe(false);
    });

    it("bounds desktop media and accepts explicit outbound roots", () => {
      expect(
        ExpressAccountSchema.safeParse({
          mediaMaxMb: 20,
          desktopMediaRoots: ["/srv/openclaw/outbound"],
          markdown: { tables: "bullets" },
          actions: { send: "allowlist" },
        }).success,
      ).toBe(true);
      expect(ExpressAccountSchema.safeParse({ mediaMaxMb: 101 }).success).toBe(
        false,
      );
    });

    it("keeps desktop acknowledgement explicit and bounded", () => {
      expect(
        ExpressAccountSchema.safeParse({
          desktopAckMode: "typing",
          desktopAckText: "Взял в работу",
        }).success,
      ).toBe(true);
      expect(
        ExpressAccountSchema.safeParse({ desktopAckMode: "unknown" }).success,
      ).toBe(false);
      expect(
        ExpressAccountSchema.safeParse({
          desktopAckText: "x".repeat(161),
        }).success,
      ).toBe(false);
    });

    it("accepts an exact multi-chat allowlist", () => {
      const result = ExpressAccountSchema.safeParse({
        mode: "desktop",
        desktopChats: [
          {
            chatId: "00000000-0000-4000-8000-000000000001",
            chatTitle: "Alice",
            senderId: "00000000-0000-4000-8000-000000000011",
            senderName: "Alice Example",
          },
          {
            chatId: "00000000-0000-4000-8000-000000000002",
            chatTitle: "Bob",
            senderId: "00000000-0000-4000-8000-000000000022",
            enabled: true,
          },
        ],
        desktopDispatchConcurrency: 2,
      });
      expect(result.success).toBe(true);
    });

    it("accepts canonical eXpress UUID-shaped ids without RFC variant bits", () => {
      expect(
        ExpressAccountSchema.safeParse({
          desktopChats: [
            {
              chatId: "11111111-2222-0333-4444-555555555555",
              chatTitle: "First Example",
              senderId: "66666666-7777-0888-3999-aaaaaaaaaaaa",
            },
            {
              chatId: "bbbbbbbb-cccc-0ddd-3eee-ffffffffffff",
              chatTitle: "Second Example",
              senderId: "12345678-9abc-0def-3456-789abcdef012",
            },
          ],
        }).success,
      ).toBe(true);
    });

    it("rejects duplicate or malformed multi-chat identities", () => {
      const duplicateChatId = ExpressAccountSchema.safeParse({
        desktopChats: [
          {
            chatId: "00000000-0000-4000-8000-000000000001",
            chatTitle: "Alice",
            senderId: "00000000-0000-4000-8000-000000000011",
          },
          {
            chatId: "00000000-0000-4000-8000-000000000001",
            chatTitle: "Mallory",
            senderId: "00000000-0000-4000-8000-000000000022",
          },
        ],
      });
      expect(duplicateChatId.success).toBe(false);
      const duplicateSenderId = ExpressAccountSchema.safeParse({
        desktopChats: [
          {
            chatId: "00000000-0000-4000-8000-000000000001",
            chatTitle: "Alice",
            senderId: "00000000-0000-4000-8000-000000000011",
          },
          {
            chatId: "00000000-0000-4000-8000-000000000002",
            chatTitle: "Bob",
            senderId: "00000000-0000-4000-8000-000000000011",
          },
        ],
      });
      expect(duplicateSenderId.success).toBe(false);
      const duplicateChatTitle = ExpressAccountSchema.safeParse({
        desktopChats: [
          {
            chatId: "00000000-0000-4000-8000-000000000001",
            chatTitle: "Alice",
            senderId: "00000000-0000-4000-8000-000000000011",
          },
          {
            chatId: "00000000-0000-4000-8000-000000000002",
            chatTitle: " Alice ",
            senderId: "00000000-0000-4000-8000-000000000022",
          },
        ],
      });
      expect(duplicateChatTitle.success).toBe(false);
      expect(
        ExpressAccountSchema.safeParse({
          desktopChats: [
            {
              chatId: "not-a-uuid",
              chatTitle: "Alice",
              senderId: "also-not-a-uuid",
            },
          ],
        }).success,
      ).toBe(false);
    });
  });

  describe("ExpressConfigSchema", () => {
    it("should accept config with accounts", () => {
      const config = {
        botId: "bot-1",
        secretKey: "key",
        ctsUrl: "https://cts.com",
        accounts: {
          prod: {
            botId: "prod-bot",
            secretKey: "prod-key",
            ctsUrl: "https://prod.cts.com",
          },
        },
      };
      const result = ExpressConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept config without accounts", () => {
      const config = {
        botId: "bot-1",
        secretKey: "key",
        ctsUrl: "https://cts.com",
      };
      const result = ExpressConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });
});
