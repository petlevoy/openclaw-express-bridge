/**
 * eXpress channel config Zod schema
 */

import {
  DmPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

function requireOpenAllowFrom(params: {
  policy: string | undefined;
  allowFrom: unknown[] | undefined;
  ctx: z.RefinementCtx;
  path: (string | number)[];
  message: string;
}): void {
  if (params.policy !== "open") return;
  const normalized = (params.allowFrom ?? []).map((entry) =>
    String(entry)
      .replace(/^express:/i, "")
      .trim(),
  );
  if (normalized.includes("*")) return;
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
}

/**
 * eXpress account config (base schema for both top-level and accounts.*)
 */
export const ExpressAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(["botx", "desktop"]).optional().default("botx"),
    markdown: MarkdownConfigSchema.optional(),
    botId: z.string().optional(),
    secretKey: z.string().optional(),
    ctsUrl: z.string().optional(),
    webhookPort: z.number().int().positive().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    streamMode: z.enum(["off", "partial", "block"]).optional(),
    mediaMaxMb: z.number().positive().max(100).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    desktopCdpUrl: z.string().url().optional(),
    desktopChatId: z.string().uuid().optional(),
    desktopChatTitle: z.string().min(1).optional(),
    desktopSenderId: z.string().uuid().optional(),
    desktopSenderName: z.string().min(1).optional(),
    desktopPollIntervalMs: z.number().int().min(250).max(60_000).optional(),
    desktopStatePath: z.string().min(1).optional(),
    desktopOutboundEnabled: z.boolean().optional(),
    desktopOutboundSwitchPath: z.string().min(1).optional(),
    desktopMediaRoots: z.array(z.string().min(1)).max(16).optional(),
    desktopAckMode: z.enum(["off", "typing", "message"]).optional(),
    desktopAckText: z.string().trim().min(1).max(160).optional(),
    actions: z
      .record(
        z.string(),
        z
          .union([z.boolean(), z.enum(["pairing", "allowlist", "open"])])
          .optional(),
      )
      .optional(),
  })
  .strict();

/**
 * Individual account schema (with open-policy validation)
 */
export const ExpressAccountSchema = ExpressAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.express.dmPolicy="open" requires channels.express.allowFrom to include "*"',
    });
  },
);

/**
 * Top-level eXpress config schema (supports accounts.* sub-configs)
 */
export const ExpressConfigSchema = ExpressAccountSchemaBase.extend({
  accounts: z.record(z.string(), ExpressAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.express.dmPolicy="open" requires channels.express.allowFrom to include "*"',
  });
});

// Re-export ToolPolicySchema for convenience
export { ToolPolicySchema };
