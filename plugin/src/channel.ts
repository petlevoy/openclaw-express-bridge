/**
 * eXpress channel plugin for OpenClaw.
 *
 * Implements the ChannelPlugin interface for the desktop bridge and BotX
 * outbound text delivery. BotX inbound remains fail-closed.
 */

import type {
  ChannelMeta,
  ChannelPlugin,
} from "openclaw/plugin-sdk/channel-runtime";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";

import {
  listExpressAccountIds,
  type ResolvedExpressAccount,
  resolveExpressAccount,
} from "./accounts.js";
import { expressMessageActions } from "./actions.js";
import { ExpressConfigSchema } from "./config-schema.js";
import { toPlainText } from "./format.js";
import {
  BOTX_INBOUND_DISABLED_MESSAGE,
  startExpressMonitor,
} from "./monitor.js";
import { expressSetupWizard } from "./onboarding.js";
import { getExpressRuntime } from "./runtime.js";
import { sendExpressMediaMessage, sendExpressMessage } from "./send.js";

// ── Meta ──

const expressMeta: ChannelMeta = {
  id: "express",
  label: "eXpress",
  selectionLabel: "eXpress (desktop or BotX outbound)",
  docsPath: "/channels/express",
  blurb: "eXpress via an allowlisted Linux client or BotX outbound text.",
  order: 91,
  aliases: ["botx", "eXpress"],
};

// ── Channel Plugin ──

export const expressPlugin: ChannelPlugin<ResolvedExpressAccount> = {
  id: "express",
  meta: expressMeta,
  setupWizard: expressSetupWizard,
  configSchema: buildChannelConfigSchema(ExpressConfigSchema),

  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
    edit: false,
    polls: false,
  },

  reload: { configPrefixes: ["channels.express"] },

  config: {
    listAccountIds: (cfg: OpenClawConfig) => listExpressAccountIds(cfg),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveExpressAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "express",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "express",
        accountId,
        clearBaseFields: ["botId", "secretKey", "ctsUrl", "name"],
      }),

    isConfigured: (account: ResolvedExpressAccount) => account.configured,

    describeAccount: (account: ResolvedExpressAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),

    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveExpressAccount({ cfg, accountId }).config.allowFrom ?? []).map(
        String,
      ),

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^express:/i, "")),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId =
        accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const expressSection = (cfg.channels as Record<string, unknown>)
        ?.express as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(
        (expressSection?.accounts as Record<string, unknown>)?.[
          resolvedAccountId
        ],
      );
      const basePath = useAccountPath
        ? `channels.express.accounts.${resolvedAccountId}.`
        : "channels.express.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("express"),
        normalizeEntry: (raw: string) => raw.replace(/^express:/i, ""),
      };
    },
    collectWarnings: () => {
      return [];
    },
  },

  pairing: {
    idLabel: "expressHuid",
    normalizeAllowEntry: (entry: string) =>
      entry.replace(/^express:/i, "").trim(),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveExpressAccount({ cfg });
      if (!account.configured) return;
      try {
        await sendExpressMessage(id, PAIRING_APPROVED_MESSAGE, {
          cfg,
          accountId: account.accountId,
        });
      } catch {
        // Non-critical
      }
    },
  },

  messaging: {
    normalizeTarget: (raw: string) => {
      const trimmed = raw.trim();
      const normalized = trimmed.startsWith("express:")
        ? trimmed.slice(8)
        : trimmed;
      // eXpress uses UUIDs for chat_ids.
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          normalized,
        )
      ) {
        return normalized;
      }
      return undefined;
    },
    targetResolver: {
      looksLikeId: (input: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          input.trim().replace(/^express:/i, ""),
        ),
      hint: "<chatUUID>",
    },
  },

  directory: {
    self: async () => {
      // BotX doesn't have a /me endpoint — botId is configured
      return null;
    },
    listPeers: async ({ cfg, accountId }) => {
      const account = resolveExpressAccount({ cfg, accountId });
      const allowFrom = account.config.allowFrom ?? [];
      return allowFrom.map((id: string) => ({
        kind: "user" as const,
        id: String(id),
        name: undefined,
      }));
    },
    listGroups: async () => {
      // BotX doesn't expose a chat list API
      return [];
    },
  },

  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) =>
      getExpressRuntime().channel.text.chunkText(toPlainText(text), limit),
    chunkerMode: "text" as const,
    textChunkLimit: 4000,

    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveExpressAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`eXpress account ${account.accountId} not configured`);
      }

      const safeText = (text ?? "").trim();
      if (!safeText) return { channel: "express" as const, to, messageId: "" };

      const result = await sendExpressMessage(to, safeText, {
        cfg,
        accountId: account.accountId,
      });

      return { channel: "express" as const, to, messageId: result.messageId };
    },

    sendPayload: async ({ to, text, accountId }) => {
      const cfg = await getExpressRuntime().config.loadConfig();
      const account = resolveExpressAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`eXpress account ${account.accountId} not configured`);
      }

      const result = await sendExpressMessage(to, text ?? "", {
        cfg,
        accountId: account.accountId,
      });

      return { channel: "express" as const, messageId: result.messageId };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveExpressAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error(`eXpress account ${account.accountId} not configured`);
      }
      if (!mediaUrl) {
        throw new Error("eXpress media path is required");
      }

      const result = await sendExpressMediaMessage(to, text ?? "", mediaUrl, {
        cfg,
        accountId: account.accountId,
      });

      return { channel: "express" as const, messageId: result.messageId };
    },
  },

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "express",
        accountId,
        name,
      }),

    validateInput: ({ accountId: _accountId, input }) => {
      const inputRecord = input as Record<string, unknown>;
      if (!inputRecord.botId && !inputRecord.secretKey && !inputRecord.ctsUrl) {
        return "eXpress requires --bot-id, --secret-key, and --cts-url.";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }) => {
      const inputRecord = input as Record<string, unknown>;
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "express",
        accountId,
        name: inputRecord.name as string | undefined,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "express",
            })
          : namedConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            express: {
              ...((next.channels as Record<string, unknown>)?.express as Record<
                string,
                unknown
              >),
              enabled: true,
              ...(inputRecord.botId ? { botId: inputRecord.botId } : {}),
              ...(inputRecord.secretKey
                ? { secretKey: inputRecord.secretKey }
                : {}),
              ...(inputRecord.ctsUrl ? { ctsUrl: inputRecord.ctsUrl } : {}),
            },
          },
        };
      }

      const expressSection =
        ((next.channels as Record<string, unknown>)?.express as Record<
          string,
          unknown
        >) ?? {};
      return {
        ...next,
        channels: {
          ...next.channels,
          express: {
            ...expressSection,
            enabled: true,
            accounts: {
              ...(expressSection.accounts as Record<string, unknown>),
              [accountId]: {
                ...((expressSection.accounts as Record<string, unknown>)?.[
                  accountId
                ] as Record<string, unknown>),
                enabled: true,
                ...(inputRecord.botId ? { botId: inputRecord.botId } : {}),
                ...(inputRecord.secretKey
                  ? { secretKey: inputRecord.secretKey }
                  : {}),
                ...(inputRecord.ctsUrl ? { ctsUrl: inputRecord.ctsUrl } : {}),
              },
            },
          },
        },
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
    }),

    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.configured) return { ok: false, error: "not configured" };
      if (account.mode === "desktop") {
        const { probeExpressDesktop } = await import("./desktop-cdp.js");
        return probeExpressDesktop(account, timeoutMs);
      }
      void timeoutMs;
      return { ok: false, error: BOTX_INBOUND_DISABLED_MESSAGE };
    },

    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),

    auditAccount: async () => {
      return {
        ok: true,
        checkedGroups: 0,
        unresolvedGroups: 0,
        groups: [],
        elapsedMs: 0,
      };
    },

    collectStatusIssues: (accounts) => {
      const issues: Array<{
        channel: string;
        accountId: string;
        kind: "config" | "permissions" | "auth" | "runtime" | "intent";
        message: string;
        fix?: string;
      }> = [];

      for (const snapshot of accounts) {
        if (!snapshot.configured) {
          issues.push({
            channel: "express",
            accountId: snapshot.accountId,
            kind: "config" as const,
            message: "eXpress transport not configured",
            fix: "Configure BotX credentials or the desktop CDP/chat allowlist fields",
          });
        }
      }

      return issues;
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log } = ctx;

      log?.info(`[${account.accountId}] Starting eXpress provider`);

      return startExpressMonitor({
        account,
        config: ctx.cfg,
        abortSignal,
        log,
        statusSink: (patch) => {
          const current = ctx.getStatus();
          ctx.setStatus({ ...current, ...patch });
        },
      });
    },

    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const channels = { ...(nextCfg.channels as Record<string, unknown>) };
      const expressSection = channels.express
        ? { ...(channels.express as Record<string, unknown>) }
        : undefined;
      let cleared = false;

      if (expressSection) {
        if (accountId === DEFAULT_ACCOUNT_ID && expressSection.botId) {
          delete expressSection.botId;
          delete expressSection.secretKey;
          delete expressSection.ctsUrl;
          cleared = true;
        }

        const accounts = expressSection.accounts as
          Record<string, unknown> | undefined;
        if (accounts && accountId in accounts) {
          delete (accounts as Record<string, unknown>)[accountId];
          cleared = true;
        }

        channels.express = expressSection;
        nextCfg.channels = channels;

        if (cleared) {
          await getExpressRuntime().config.writeConfigFile(nextCfg);
        }
      }

      return { cleared, loggedOut: cleared };
    },
  },

  // Message actions
  actions: expressMessageActions,
};
