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
