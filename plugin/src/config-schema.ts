/**
 * eXpress channel config Zod schema
 */

import {
  DmPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const ExpressUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "invalid eXpress UUID",
  );

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

const DesktopChatSchema = z
  .object({
    chatId: ExpressUuidSchema,
    chatTitle: z.string().trim().min(1),
    senderId: ExpressUuidSchema,
    senderName: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

function validateDesktopChats(
  value: {
    desktopChats?: Array<{
      chatId: string;
      chatTitle: string;
      senderId: string;
    }>;
  },
  ctx: z.RefinementCtx,
): void {
  const chatIds = new Set<string>();
  const chatTitles = new Set<string>();
  const senderIds = new Set<string>();
  for (const [index, chat] of (value.desktopChats ?? []).entries()) {
    const chatId = chat.chatId.toLowerCase();
    const chatTitle = chat.chatTitle.trim();
    const senderId = chat.senderId.toLowerCase();
    if (chatIds.has(chatId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desktopChats", index, "chatId"],
        message: "desktopChats chatId values must be unique",
      });
    }
    if (senderIds.has(senderId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desktopChats", index, "senderId"],
        message: "desktopChats senderId values must be unique",
      });
    }
    if (chatTitles.has(chatTitle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["desktopChats", index, "chatTitle"],
        message: "desktopChats chatTitle values must be unique",
      });
    }
    chatIds.add(chatId);
    chatTitles.add(chatTitle);
    senderIds.add(senderId);
  }
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
    desktopChatId: ExpressUuidSchema.optional(),
    desktopChatTitle: z.string().min(1).optional(),
    desktopSenderId: ExpressUuidSchema.optional(),
    desktopSenderName: z.string().min(1).optional(),
    desktopChats: z.array(DesktopChatSchema).min(1).max(32).optional(),
    desktopDispatchConcurrency: z.number().int().min(1).max(8).optional(),
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
    validateDesktopChats(value, ctx);
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
  validateDesktopChats(value, ctx);
});

// Re-export ToolPolicySchema for convenience
export { ToolPolicySchema };
