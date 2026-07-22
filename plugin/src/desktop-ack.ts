/** Immediate, fail-soft acknowledgement for validated desktop inbound. */

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  type ExpressDesktopClient,
  isDesktopOutboundUnlocked,
} from "./desktop-cdp.js";

export const DEFAULT_DESKTOP_ACK_TEXT = "Взял в работу";
export const DESKTOP_TYPING_KEEPALIVE_MS = 5_000;

type DesktopAckClient = Pick<ExpressDesktopClient, "sendText" | "setTyping">;

export interface DesktopAckHandle {
  kind: "none" | "typing" | "message";
  stop: () => Promise<void>;
}

export interface DesktopAckOptions {
  account: ResolvedExpressAccount;
  client: DesktopAckClient;
  targetChatId: string;
  claim?: () => Promise<boolean>;
  isUnlocked?: () => Promise<boolean>;
  keepaliveMs?: number;
  onActivity?: (kind: "typing" | "message") => void;
  onError?: (kind: "typing" | "message", error: unknown) => void;
}

const NO_ACK: DesktopAckHandle = {
  kind: "none",
  stop: async () => {},
};

function normalizedAckText(account: ResolvedExpressAccount): string {
  const text = (account.config.desktopAckText ?? DEFAULT_DESKTOP_ACK_TEXT)
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 160) {
    throw new Error("desktop acknowledgement text is invalid");
  }
  return text;
}

async function sendTextAcknowledgement(
  options: DesktopAckOptions,
  isUnlocked: () => Promise<boolean>,
): Promise<DesktopAckHandle> {
  try {
    if (!(await isUnlocked())) return NO_ACK;
    await options.client.sendText(
      options.targetChatId,
      normalizedAckText(options.account),
    );
    options.onActivity?.("message");
    return { kind: "message", stop: async () => {} };
  } catch (error) {
    options.onError?.("message", error);
    return NO_ACK;
  }
}

function isNativeTypingUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "desktop native typing action is unavailable"
  );
}

/**
 * Start the configured acknowledgement. `typing` invokes the client's own
 * start/stop action and refreshes it while OpenClaw works. If that verified
 * client action is unavailable, one short text acknowledgement is used.
 * Every outbound activity independently re-checks both interlocks.
 */
export async function startDesktopInboundAcknowledgement(
  options: DesktopAckOptions,
): Promise<DesktopAckHandle> {
  const mode = options.account.config.desktopAckMode ?? "off";
  if (mode === "off") return NO_ACK;

  const isUnlocked =
    options.isUnlocked ?? (() => isDesktopOutboundUnlocked(options.account));
  try {
    if (!(await isUnlocked())) return NO_ACK;
    if (options.claim && !(await options.claim())) return NO_ACK;
  } catch (error) {
    options.onError?.(mode === "typing" ? "typing" : "message", error);
    return NO_ACK;
  }
  if (mode === "message") {
    return sendTextAcknowledgement(options, isUnlocked);
  }

  const keepaliveMs = options.keepaliveMs ?? DESKTOP_TYPING_KEEPALIVE_MS;
  if (!Number.isFinite(keepaliveMs) || keepaliveMs < 250) {
    options.onError?.(
      "typing",
      new Error("desktop typing keepalive interval is invalid"),
    );
    return NO_ACK;
  }

  try {
    if (!(await isUnlocked())) return NO_ACK;
    await options.client.setTyping(options.targetChatId, true);
    options.onActivity?.("typing");
  } catch (error) {
    options.onError?.("typing", error);
    return isNativeTypingUnavailable(error)
      ? sendTextAcknowledgement(options, isUnlocked)
      : NO_ACK;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = (async () => {
        if (!(await isUnlocked())) {
          stopped = true;
          return;
        }
        try {
          await options.client.setTyping(options.targetChatId, true);
        } catch (error) {
          stopped = true;
          options.onError?.("typing", error);
        }
        schedule();
      })().catch((error) => {
        stopped = true;
        options.onError?.("typing", error);
      });
    }, keepaliveMs);
    timer.unref?.();
  };
  schedule();

  return {
    kind: "typing",
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      try {
        if (await isUnlocked()) {
          await options.client.setTyping(options.targetChatId, false);
        }
      } catch (error) {
        options.onError?.("typing", error);
      }
    },
  };
}

/** Ensure acknowledgement starts before work and always stops afterwards. */
export async function withDesktopInboundAcknowledgement<T>(
  options: DesktopAckOptions,
  work: (acknowledgement: DesktopAckHandle) => Promise<T>,
): Promise<T> {
  const acknowledgement = await startDesktopInboundAcknowledgement(options);
  try {
    return await work(acknowledgement);
  } finally {
    await acknowledgement.stop();
  }
}
