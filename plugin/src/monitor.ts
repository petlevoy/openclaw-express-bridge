/** eXpress monitor entry point. */

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { ResolvedExpressAccount } from "./accounts.js";
import { startExpressDesktopMonitor } from "./desktop-monitor.js";

export interface ExpressMonitorOptions {
  account: ResolvedExpressAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    running?: boolean;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
  }) => void;
}

export const BOTX_INBOUND_DISABLED_MESSAGE =
  "eXpress BotX inbound is disabled until the verified BotX JWT v2 contract and shared OpenClaw listener are implemented";

export async function startExpressMonitor(
  opts: ExpressMonitorOptions,
): Promise<void> {
  if (opts.account.mode === "desktop") {
    return startExpressDesktopMonitor(opts);
  }

  // The previous per-account webhook accepted unsigned JSON. It is deliberately
  // not started: allowlists and bot_id checks cannot authenticate a request.
  // Do not add an opt-in bypass here. BotX inbound may be restored only against
  // verified local SDK/types for JWT v2 and the host's shared HTTP listener.
  opts.log?.warn?.(
    `[${opts.account.accountId}] ${BOTX_INBOUND_DISABLED_MESSAGE}`,
  );
  opts.statusSink?.({
    running: true,
    lastStartAt: Date.now(),
    lastError: BOTX_INBOUND_DISABLED_MESSAGE,
  });
  if (!opts.abortSignal.aborted) {
    await new Promise<void>((resolve) => {
      opts.abortSignal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
  opts.statusSink?.({
    running: false,
    lastStopAt: Date.now(),
  });
}
