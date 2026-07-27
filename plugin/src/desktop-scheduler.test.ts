import { describe, expect, it } from "vitest";

import {
  DesktopDispatchScheduler,
  DesktopRoundRobin,
} from "./desktop-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("desktop multi-chat scheduler", () => {
  it("polls configured chats in round-robin order", () => {
    const roundRobin = new DesktopRoundRobin(["a", "b", "c"]);
    expect([
      roundRobin.next(),
      roundRobin.next(),
      roundRobin.next(),
      roundRobin.next(),
    ]).toEqual(["a", "b", "c", "a"]);
  });

  it("keeps one chat sequential without blocking another chat", async () => {
    const scheduler = new DesktopDispatchScheduler({ concurrency: 2 });
    const first = deferred();
    const events: string[] = [];

    expect(
      scheduler.enqueue("chat-a", async () => {
        events.push("a1-start");
        await first.promise;
        events.push("a1-end");
      }),
    ).toBe(true);
    scheduler.enqueue("chat-a", async () => {
      events.push("a2");
    });
    scheduler.enqueue("chat-b", async () => {
      events.push("b1");
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(events).toEqual(["a1-start", "b1"]);
    first.resolve();
    await scheduler.onIdle();
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });

  it("bounds each chat queue independently", async () => {
    const scheduler = new DesktopDispatchScheduler({
      concurrency: 1,
      maxPendingPerChat: 1,
    });
    const gate = deferred();
    expect(scheduler.enqueue("chat-a", () => gate.promise)).toBe(true);
    expect(scheduler.enqueue("chat-a", async () => {})).toBe(false);
    expect(scheduler.enqueue("chat-b", async () => {})).toBe(true);
    gate.resolve();
    await scheduler.onIdle();
  });
});
