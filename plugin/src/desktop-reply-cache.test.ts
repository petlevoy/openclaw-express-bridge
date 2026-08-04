import { describe, expect, it } from "vitest";

import { DesktopFinalReplyCache } from "./desktop-reply-cache.js";

describe("desktop final reply cache", () => {
  it("returns a remembered final so a retry never re-runs the turn", () => {
    const cache = new DesktopFinalReplyCache();
    cache.remember("message-one", { text: "answer" });
    expect(cache.get("message-one")).toEqual({
      text: "answer",
      mediaUrls: undefined,
    });
  });

  it("ignores payloads with nothing deliverable", () => {
    const cache = new DesktopFinalReplyCache();
    cache.remember("empty-text", { text: "   " });
    cache.remember("empty-media", { mediaUrls: [] });
    expect(cache.get("empty-text")).toBeUndefined();
    expect(cache.get("empty-media")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("expires an entry instead of re-sending a stale answer", () => {
    const cache = new DesktopFinalReplyCache(1_000);
    cache.remember("message-two", { text: "answer" }, 10_000);
    expect(cache.get("message-two", 10_500)).toEqual({
      text: "answer",
      mediaUrls: undefined,
    });
    expect(cache.get("message-two", 11_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the oldest entry once capacity is reached", () => {
    const cache = new DesktopFinalReplyCache(60_000, 2);
    cache.remember("one", { text: "a" });
    cache.remember("two", { text: "b" });
    cache.remember("three", { text: "c" });
    expect(cache.get("one")).toBeUndefined();
    expect(cache.get("two")).toBeDefined();
    expect(cache.get("three")).toBeDefined();
  });

  it("clears an entry once the reply is confirmed", () => {
    const cache = new DesktopFinalReplyCache();
    cache.remember("message-three", { text: "answer" });
    cache.clear("message-three");
    expect(cache.get("message-three")).toBeUndefined();
  });

  it("copies media lists so a later mutation cannot change the retry", () => {
    const cache = new DesktopFinalReplyCache();
    const mediaUrls = ["/tmp/one.pdf"];
    cache.remember("message-four", { mediaUrls });
    mediaUrls.push("/tmp/two.pdf");
    expect(cache.get("message-four")?.mediaUrls).toEqual(["/tmp/one.pdf"]);
  });

  it("rejects an invalid configuration instead of caching forever", () => {
    expect(() => new DesktopFinalReplyCache(0)).toThrow(/ttl is invalid/);
    expect(() => new DesktopFinalReplyCache(1_000, 0)).toThrow(
      /capacity is invalid/,
    );
  });
});
