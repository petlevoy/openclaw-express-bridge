import { describe, expect, it } from "vitest";

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  BOTX_INBOUND_DISABLED_MESSAGE,
  startExpressMonitor,
} from "./monitor.js";

describe("eXpress monitor security", () => {
  it("keeps BotX inbound dormant without blocking outbound lifecycle", async () => {
    const account = {
      accountId: "default",
      configured: true,
      enabled: true,
      mode: "botx",
      botId: "00000000-0000-4000-8000-000000000001",
      secretKey: "test-only-secret",
      ctsUrl: "https://cts.example.com",
      webhookPort: 18790,
      config: {},
    } satisfies ResolvedExpressAccount;

    const controller = new AbortController();
    const patches: Array<{ running?: boolean; lastError?: string | null }> = [];
    const monitor = startExpressMonitor({
      account,
      config: { channels: {} },
      abortSignal: controller.signal,
      statusSink: (patch) => patches.push(patch),
    });
    await Promise.resolve();

    expect(patches[0]).toMatchObject({
      running: true,
      lastError: BOTX_INBOUND_DISABLED_MESSAGE,
    });
    controller.abort();
    await expect(monitor).resolves.toBeUndefined();
    expect(patches.at(-1)).toMatchObject({ running: false });
  });
});
