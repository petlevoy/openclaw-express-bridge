import { describe, expect, it } from "vitest";

import {
  DesktopDispatchRateLimiter,
  redactDesktopError,
  selectDesktopInboundBatch,
} from "./desktop-safety.js";

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("eXpress desktop safety controls", () => {
  it("builds a deduplicated bounded queue without retaining message whitespace", () => {
    const seen = new Set([id("1")]);
    expect(
      selectDesktopInboundBatch(
        [
          { id: id("1"), text: "old" },
          { id: id("2"), text: "  new  " },
          { id: id("2"), text: "duplicate" },
        ],
        (messageId) => seen.has(messageId),
      ),
    ).toEqual([{ id: id("2"), text: "new" }]);
  });

  it("fails closed on malformed ids, oversized text, and queue overflow", () => {
    expect(() =>
      selectDesktopInboundBatch([{ id: "bad", text: "x" }], () => false),
    ).toThrow(/id is invalid/);
    expect(() =>
      selectDesktopInboundBatch(
        [{ id: id("3"), text: "x".repeat(32_769) }],
        () => false,
      ),
    ).toThrow(/safety limit/);
    expect(() =>
      selectDesktopInboundBatch(
        [
          { id: id("4"), text: "a" },
          { id: id("5"), text: "b" },
        ],
        () => false,
        1,
      ),
    ).toThrow(/capacity/);
  });

  it("reserves sequential rate-limited dispatch slots", () => {
    const limiter = new DesktopDispatchRateLimiter(500);
    expect(limiter.reserve(1_000)).toBe(0);
    expect(limiter.reserve(1_100)).toBe(400);
    expect(limiter.reserve(1_700)).toBe(300);
  });

  it("redacts ids and URLs from desktop errors", () => {
    const message = redactDesktopError(
      new Error(`chat ${id("7")} failed at http://127.0.0.1:18997/path`),
    );
    expect(message).toBe("chat [redacted-id] failed at [redacted-url]");
  });
});
