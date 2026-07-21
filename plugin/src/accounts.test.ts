/**
 * Tests for eXpress account resolution
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";

import {
  listExpressAccountIds,
  resolveDefaultExpressAccountId,
  resolveExpressAccount,
} from "./accounts.js";

describe("eXpress Account Resolution", () => {
  describe("listExpressAccountIds", () => {
    it("should return empty array when eXpress not configured", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const ids = listExpressAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("should return default account when top-level botId exists", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            botId: "bot-uuid",
            secretKey: "secret",
            ctsUrl: "https://cts.example.com",
          },
        },
      };
      const ids = listExpressAccountIds(cfg);
      expect(ids).toContain("default");
    });

    it("should list named accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            accounts: {
              prod: {
                botId: "prod-bot",
                secretKey: "prod-key",
                ctsUrl: "https://prod.cts.com",
              },
              dev: {
                botId: "dev-bot",
                secretKey: "dev-key",
                ctsUrl: "https://dev.cts.com",
              },
            },
          },
        },
      };
      const ids = listExpressAccountIds(cfg);
      expect(ids).toContain("prod");
      expect(ids).toContain("dev");
    });

    it("should return default when section exists but no accounts", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: { enabled: true },
        },
      };
      const ids = listExpressAccountIds(cfg);
      expect(ids).toContain("default");
    });
  });

  describe("resolveDefaultExpressAccountId", () => {
    it("should always return 'default'", () => {
      const cfg: OpenClawConfig = { channels: {} };
      const id = resolveDefaultExpressAccountId(cfg);
      expect(id).toBe("default");
    });
  });

  describe("resolveExpressAccount", () => {
    it("should resolve default account with credentials from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            enabled: true,
            botId: "bot-uuid",
            secretKey: "secret-key",
            ctsUrl: "https://cts.example.com/",
            name: "Main Bot",
            webhookPort: 18800,
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.botId).toBe("bot-uuid");
      expect(account.secretKey).toBe("secret-key");
      expect(account.ctsUrl).toBe("https://cts.example.com"); // trailing slash stripped
      expect(account.webhookPort).toBe(18800);
      expect(account.configured).toBe(true);
      expect(account.enabled).toBe(true);
      expect(account.name).toBe("Main Bot");
    });

    it("should resolve named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            accounts: {
              prod: {
                enabled: true,
                botId: "prod-bot-id",
                secretKey: "prod-secret",
                ctsUrl: "https://prod.cts.com",
                name: "Production Bot",
              },
            },
          },
        },
      };
      const account = resolveExpressAccount({ cfg, accountId: "prod" });
      expect(account.accountId).toBe("prod");
      expect(account.botId).toBe("prod-bot-id");
      expect(account.secretKey).toBe("prod-secret");
      expect(account.ctsUrl).toBe("https://prod.cts.com");
      expect(account.configured).toBe(true);
      expect(account.name).toBe("Production Bot");
    });

    it("should handle account with no credentials", () => {
      const cfg: OpenClawConfig = {
        channels: { express: {} },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.botId).toBe("");
      expect(account.secretKey).toBe("");
      expect(account.ctsUrl).toBe("");
      expect(account.configured).toBe(false);
    });

    it("should resolve a configured desktop account without BotX credentials", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            enabled: true,
            mode: "desktop",
            desktopCdpUrl: "http://127.0.0.1:18997",
            desktopChatId: "00000000-0000-4000-8000-000000000001",
            desktopChatTitle: "Example Chat",
            desktopSenderId: "00000000-0000-4000-8000-000000000002",
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.mode).toBe("desktop");
      expect(account.configured).toBe(true);
      expect(account.botId).toBe("");
    });

    it("should use default webhook port", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            botId: "bot",
            secretKey: "key",
            ctsUrl: "https://cts.com",
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.webhookPort).toBe(18790);
    });

    it("should default enabled to true", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            botId: "bot",
            secretKey: "key",
            ctsUrl: "https://cts.com",
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.enabled).toBe(true);
    });

    it("should respect enabled=false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            enabled: false,
            botId: "bot",
            secretKey: "key",
            ctsUrl: "https://cts.com",
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.enabled).toBe(false);
    });

    it("should merge config fields for default account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          express: {
            botId: "bot",
            secretKey: "key",
            ctsUrl: "https://cts.com",
            dmPolicy: "allowlist",
            allowFrom: ["huid-1", "huid-2"],
          },
        },
      };
      const account = resolveExpressAccount({ cfg });
      expect(account.config.dmPolicy).toBe("allowlist");
      expect(account.config.allowFrom).toEqual(["huid-1", "huid-2"]);
    });
  });
});
