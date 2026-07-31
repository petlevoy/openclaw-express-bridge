import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

interface WaitingToolCall {
  callId: string;
  runId?: string;
  resolve: () => void;
}

interface ActiveToolCall {
  runId?: string;
  lease: ReturnType<typeof setTimeout>;
}

function isExpressToolContext(ctx: {
  channelId?: string;
  sessionKey?: string;
}): boolean {
  return (
    ctx.channelId?.toLowerCase() === "express" ||
    ctx.sessionKey?.toLowerCase().includes(":express:") === true
  );
}

/**
 * Bound native tool fan-out for eXpress-originated runs. Codex can request a
 * large parallel batch in one model turn; without a host-side gate all of the
 * result serialization and transcript writes land on the Gateway event loop
 * at once.
 */
export class ExpressToolConcurrencyGuard {
  private readonly active = new Map<string, ActiveToolCall>();
  private readonly waiting: WaitingToolCall[] = [];

  constructor(
    readonly limit = 3,
    readonly leaseMs = 15 * 60 * 1000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        "eXpress tool concurrency limit must be a positive integer",
      );
    }
    if (!Number.isFinite(leaseMs) || leaseMs < 1) {
      throw new Error("eXpress tool concurrency lease must be positive");
    }
  }

  async acquire(callId: string, runId?: string): Promise<void> {
    if (this.active.has(callId)) return;
    if (this.active.size < this.limit) {
      this.activate(callId, runId);
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push({ callId, runId, resolve });
    });
  }

  release(callId: string): void {
    const active = this.active.get(callId);
    if (!active) {
      const queuedIndex = this.waiting.findIndex(
        (waiting) => waiting.callId === callId,
      );
      if (queuedIndex >= 0) this.waiting.splice(queuedIndex, 1);
      return;
    }
    clearTimeout(active.lease);
    this.active.delete(callId);
    this.releaseNext();
  }

  releaseRun(runId?: string): void {
    if (!runId) return;
    for (const [callId, active] of this.active) {
      if (active.runId !== runId) continue;
      clearTimeout(active.lease);
      this.active.delete(callId);
    }
    this.releaseAvailable();
  }

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  private releaseAvailable(): void {
    while (this.active.size < this.limit && this.waiting.length > 0) {
      this.releaseNext();
    }
  }

  private releaseNext(): void {
    const next = this.waiting.shift();
    if (!next) return;
    this.activate(next.callId, next.runId);
    next.resolve();
  }

  private activate(callId: string, runId?: string): void {
    const lease = setTimeout(() => this.release(callId), this.leaseMs);
    lease.unref?.();
    this.active.set(callId, { runId, lease });
  }
}

export function registerExpressToolConcurrencyGuard(
  api: OpenClawPluginApi,
  limit = 3,
): ExpressToolConcurrencyGuard {
  const guard = new ExpressToolConcurrencyGuard(limit);

  api.on(
    "before_tool_call",
    async (_event, ctx) => {
      if (!isExpressToolContext(ctx) || !ctx.toolCallId) return;
      await guard.acquire(ctx.toolCallId, ctx.runId);
    },
    { timeoutMs: 15 * 60 * 1000 },
  );
  api.on("after_tool_call", (_event, ctx) => {
    if (!isExpressToolContext(ctx) || !ctx.toolCallId) return;
    guard.release(ctx.toolCallId);
  });
  return guard;
}
