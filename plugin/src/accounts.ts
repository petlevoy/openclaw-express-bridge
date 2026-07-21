/**
 * eXpress account resolution — reads config and produces a resolved account object.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";

import type { ExpressAccountConfig } from "./types.js";

export interface ResolvedExpressAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  mode: "botx" | "desktop";
  botId: string;
  secretKey: string;
  ctsUrl: string;
  webhookPort: number;
  config: ExpressAccountConfig;
}

const DEFAULT_WEBHOOK_PORT = 18790;

/**
 * Get the eXpress channel section from config.
 */
function getExpressSection(
  cfg: OpenClawConfig,
): Record<string, unknown> | undefined {
  return (cfg.channels as Record<string, unknown>)?.express as
    Record<string, unknown> | undefined;
}

/**
 * List all eXpress account IDs from config.
 */
export function listExpressAccountIds(cfg: OpenClawConfig): string[] {
  const section = getExpressSection(cfg);
  if (!section) return [];

  const ids: string[] = [];

  // Check for default account (top-level botId + secretKey)
  const hasDefault = section.botId || section.secretKey || section.ctsUrl;
  if (hasDefault) ids.push(DEFAULT_ACCOUNT_ID);

  // Check for named accounts
  const accounts = section.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    for (const key of Object.keys(accounts)) {
      const normalized = normalizeAccountId(key);
      if (normalized !== DEFAULT_ACCOUNT_ID && !ids.includes(normalized)) {
        ids.push(normalized);
      }
    }
  }

  // If section exists but no token sources found, still return default
  if (ids.length === 0 && section.enabled !== false) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultExpressAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a single eXpress account from config.
 */
export function resolveExpressAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedExpressAccount {
  const { cfg, accountId: rawId } = params;
  const accountId = rawId ? normalizeAccountId(rawId) : DEFAULT_ACCOUNT_ID;
  const section = getExpressSection(cfg) ?? {};
  const accounts = section.accounts as
    Record<string, Record<string, unknown>> | undefined;

  let accountConfig: ExpressAccountConfig;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Default account: top-level config
    accountConfig = {
      enabled: section.enabled !== false,
      mode: section.mode as ExpressAccountConfig["mode"],
      botId: section.botId as string | undefined,
      secretKey: section.secretKey as string | undefined,
      ctsUrl: section.ctsUrl as string | undefined,
      webhookPort: section.webhookPort as number | undefined,
      name: section.name as string | undefined,
      dmPolicy: section.dmPolicy as ExpressAccountConfig["dmPolicy"],
      allowFrom: section.allowFrom as string[] | undefined,
      streamMode: section.streamMode as ExpressAccountConfig["streamMode"],
      mediaMaxMb: section.mediaMaxMb as number | undefined,
      textChunkLimit: section.textChunkLimit as number | undefined,
      desktopCdpUrl: section.desktopCdpUrl as string | undefined,
      desktopChatId: section.desktopChatId as string | undefined,
      desktopChatTitle: section.desktopChatTitle as string | undefined,
      desktopSenderId: section.desktopSenderId as string | undefined,
      desktopSenderName: section.desktopSenderName as string | undefined,
      desktopPollIntervalMs: section.desktopPollIntervalMs as
        number | undefined,
      desktopStatePath: section.desktopStatePath as string | undefined,
      desktopOutboundEnabled: section.desktopOutboundEnabled as
        boolean | undefined,
      desktopOutboundSwitchPath: section.desktopOutboundSwitchPath as
        string | undefined,
    };
  } else {
    // Named account
    const raw = accounts?.[accountId] ?? {};
    accountConfig = {
      enabled: raw.enabled !== false,
      mode: raw.mode as ExpressAccountConfig["mode"],
      botId: raw.botId as string | undefined,
      secretKey: raw.secretKey as string | undefined,
      ctsUrl: raw.ctsUrl as string | undefined,
      webhookPort: raw.webhookPort as number | undefined,
      name: raw.name as string | undefined,
      dmPolicy: raw.dmPolicy as ExpressAccountConfig["dmPolicy"],
      allowFrom: raw.allowFrom as string[] | undefined,
      streamMode: raw.streamMode as ExpressAccountConfig["streamMode"],
      mediaMaxMb: raw.mediaMaxMb as number | undefined,
      textChunkLimit: raw.textChunkLimit as number | undefined,
      desktopCdpUrl: raw.desktopCdpUrl as string | undefined,
      desktopChatId: raw.desktopChatId as string | undefined,
      desktopChatTitle: raw.desktopChatTitle as string | undefined,
      desktopSenderId: raw.desktopSenderId as string | undefined,
      desktopSenderName: raw.desktopSenderName as string | undefined,
      desktopPollIntervalMs: raw.desktopPollIntervalMs as number | undefined,
      desktopStatePath: raw.desktopStatePath as string | undefined,
      desktopOutboundEnabled: raw.desktopOutboundEnabled as boolean | undefined,
      desktopOutboundSwitchPath: raw.desktopOutboundSwitchPath as
        string | undefined,
    };
  }

  const botId = accountConfig.botId ?? "";
  const secretKey = accountConfig.secretKey ?? "";
  const ctsUrl = (accountConfig.ctsUrl ?? "").replace(/\/$/, "");
  const webhookPort = accountConfig.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const mode = accountConfig.mode ?? "botx";
  const configured =
    mode === "desktop"
      ? Boolean(
          accountConfig.desktopCdpUrl?.trim() &&
          accountConfig.desktopChatId?.trim() &&
          accountConfig.desktopChatTitle?.trim() &&
          accountConfig.desktopSenderId?.trim(),
        )
      : Boolean(botId.trim() && secretKey.trim() && ctsUrl.trim());
  const enabled = accountConfig.enabled ?? true;

  return {
    accountId,
    name: accountConfig.name,
    enabled,
    configured,
    mode,
    botId,
    secretKey,
    ctsUrl,
    webhookPort,
    config: accountConfig,
  };
}
