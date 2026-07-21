/**
 * eXpress channel onboarding — setup wizard for `openclaw channel add express`
 */

import type { DmPolicy } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupInput,
  ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup";

import { listExpressAccountIds, resolveExpressAccount } from "./accounts.js";

const channel = "express" as const;

function setExpressDmPolicy(
  cfg: OpenClawConfig,
  policy: DmPolicy,
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      express: {
        ...cfg.channels?.["express"],
        dmPolicy: policy,
      },
    },
  };
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "eXpress",
  channel,
  policyKey: "channels.express.dmPolicy",
  allowFromKey: "channels.express.allowFrom",
  getCurrent: (cfg: OpenClawConfig) =>
    cfg.channels?.["express"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) =>
    setExpressDmPolicy(cfg, policy),
};

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        express: {
          ...cfg.channels?.["express"],
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      express: {
        ...cfg.channels?.["express"],
        enabled: true,
        accounts: {
          ...cfg.channels?.["express"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["express"]?.accounts?.[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

export const expressSetupWizard: ChannelSetupWizard = {
  channel,

  status: {
    configuredLabel: "eXpress (configured)",
    unconfiguredLabel: "eXpress Messenger",
    configuredHint: "configured",
    unconfiguredHint: "needs botId + secretKey + ctsUrl",
    resolveConfigured: ({ cfg }) => {
      return listExpressAccountIds(cfg).some(
        (accountId) => resolveExpressAccount({ cfg, accountId }).configured,
      );
    },
    resolveStatusLines: ({ cfg: _cfg, configured }) => {
      return [
        `eXpress: ${configured ? "configured" : "needs botId + secretKey + ctsUrl"}`,
      ];
    },
  },

  introNote: {
    title: "eXpress setup",
    lines: [
      "eXpress messenger bot requires a BotX API botId, secretKey, and CTS server URL.",
      "Obtain these from your eXpress CTS admin panel.",
      "The bot receives messages via webhook (ensure port 18790 is reachable).",
      `Docs: ${formatDocsLink("/channels/express", "channels/express")}`,
    ],
  },

  envShortcut: undefined,

  credentials: [
    {
      inputKey: "token" as keyof ChannelSetupInput,
      providerHint: "eXpress Bot UUID",
      credentialLabel: "bot ID",
      preferredEnvVar: "EXPRESS_BOT_ID",
      envPrompt: "Use EXPRESS_BOT_ID env var?",
      keepPrompt: "Keep current bot ID?",
      inputPrompt: "eXpress bot UUID",

      inspect: ({ cfg, accountId }) => {
        const account = resolveExpressAccount({ cfg, accountId });
        const envValue =
          accountId === DEFAULT_ACCOUNT_ID
            ? process.env.EXPRESS_BOT_ID
            : undefined;

        return {
          accountConfigured: account.configured,
          hasConfiguredValue: Boolean(account.botId),
          resolvedValue: account.botId || undefined,
          envValue,
        };
      },

      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,

      applyUseEnv: ({ cfg, accountId }) => {
        return applyAccountConfig({ cfg, accountId, patch: {} });
      },

      applySet: async ({ cfg, accountId, value: _value, resolvedValue }) => {
        const botIdValue = String(resolvedValue).trim();
        return applyAccountConfig({
          cfg,
          accountId,
          patch: { botId: botIdValue },
        });
      },
    },
    {
      inputKey: "privateKey" as keyof ChannelSetupInput,
      providerHint: "eXpress secret key",
      credentialLabel: "secret key",
      preferredEnvVar: "EXPRESS_SECRET_KEY",
      envPrompt: "Use EXPRESS_SECRET_KEY env var?",
      keepPrompt: "Keep current secret key?",
      inputPrompt: "eXpress secret key",

      inspect: ({ cfg, accountId }) => {
        const account = resolveExpressAccount({ cfg, accountId });
        const envValue =
          accountId === DEFAULT_ACCOUNT_ID
            ? process.env.EXPRESS_SECRET_KEY
            : undefined;

        return {
          accountConfigured: account.configured,
          hasConfiguredValue: Boolean(account.secretKey),
          resolvedValue: account.secretKey || undefined,
          envValue,
        };
      },

      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,

      applyUseEnv: ({ cfg, accountId }) => {
        return applyAccountConfig({ cfg, accountId, patch: {} });
      },

      applySet: async ({ cfg, accountId, value: _value, resolvedValue }) => {
        const keyValue = String(resolvedValue).trim();
        return applyAccountConfig({
          cfg,
          accountId,
          patch: { secretKey: keyValue },
        });
      },
    },
    {
      inputKey: "httpUrl" as keyof ChannelSetupInput,
      providerHint: "eXpress CTS server URL",
      credentialLabel: "CTS URL",
      preferredEnvVar: "EXPRESS_CTS_URL",
      envPrompt: "Use EXPRESS_CTS_URL env var?",
      keepPrompt: "Keep current CTS URL?",
      inputPrompt: "eXpress CTS server URL (e.g. https://cts.example.com)",

      inspect: ({ cfg, accountId }) => {
        const account = resolveExpressAccount({ cfg, accountId });
        const envValue =
          accountId === DEFAULT_ACCOUNT_ID
            ? process.env.EXPRESS_CTS_URL
            : undefined;

        return {
          accountConfigured: account.configured,
          hasConfiguredValue: Boolean(account.ctsUrl),
          resolvedValue: account.ctsUrl || undefined,
          envValue,
        };
      },

      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,

      applyUseEnv: ({ cfg, accountId }) => {
        return applyAccountConfig({ cfg, accountId, patch: {} });
      },

      applySet: async ({ cfg, accountId, value: _value, resolvedValue }) => {
        const urlValue = String(resolvedValue).trim();
        return applyAccountConfig({
          cfg,
          accountId,
          patch: { ctsUrl: urlValue },
        });
      },
    },
  ],

  textInputs: [
    {
      inputKey: "httpPort" as keyof ChannelSetupInput,
      message: "Webhook port (default: 18790)",
      placeholder: "18790",
      required: false,

      shouldPrompt: ({ cfg, accountId }) => {
        const account = resolveExpressAccount({ cfg, accountId });
        return !account.config.webhookPort;
      },

      applySet: ({ cfg, accountId, value }) => {
        const port = parseInt(value.trim(), 10);
        if (!port || isNaN(port)) return cfg;
        return applyAccountConfig({
          cfg,
          accountId,
          patch: { webhookPort: port },
        });
      },
    },
  ],

  finalize: ({ cfg, accountId: _accountId }) => {
    return {
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          express: {
            ...cfg.channels?.["express"],
            enabled: true,
          },
        },
      },
    };
  },

  dmPolicy,
};
