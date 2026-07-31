import { describe, expect, it, vi } from "vitest";

import { ExpressToolConcurrencyGuard } from "./tool-concurrency-guard.js";

describe("ExpressToolConcurrencyGuard", () => {
  it("admits only the configured number of concurrent tool calls", async () => {
    const guard = new ExpressToolConcurrencyGuard(2);
    await guard.acquire("one", "run");
    await guard.acquire("two", "run");
    const admitted = vi.fn();
    const pending = guard.acquire("three", "run").then(admitted);

    await Promise.resolve();
    expect(guard.activeCount).toBe(2);
    expect(guard.waitingCount).toBe(1);
    expect(admitted).not.toHaveBeenCalled();

    guard.release("one");
    await pending;
    expect(admitted).toHaveBeenCalledOnce();
    expect(guard.activeCount).toBe(2);
    expect(guard.waitingCount).toBe(0);
  });

  it("releases permits owned by a completed run", async () => {
    const guard = new ExpressToolConcurrencyGuard(1);
    await guard.acquire("one", "run-one");
    const pending = guard.acquire("two", "run-two");

    guard.releaseRun("run-one");
    await pending;
    expect(guard.activeCount).toBe(1);
    expect(guard.waitingCount).toBe(0);
  });

  it("releases a permit when its safety lease expires", async () => {
    vi.useFakeTimers();
    try {
      const guard = new ExpressToolConcurrencyGuard(1, 100);
      await guard.acquire("one", "run-one");
      const pending = guard.acquire("two", "run-two");

      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(guard.activeCount).toBe(1);
      expect(guard.waitingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
