import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDesktopSnapshotExpression,
  DesktopDedupeStore,
  normalizeLoopbackCdpUrl,
} from "./desktop-cdp.js";

describe("eXpress desktop CDP bridge", () => {
  it("accepts only loopback CDP endpoints", () => {
    expect(normalizeLoopbackCdpUrl("http://127.0.0.1:18997/")).toBe(
      "http://127.0.0.1:18997",
    );
    expect(() => normalizeLoopbackCdpUrl("https://example.com:18997")).toThrow(
      /loopback/,
    );
  });

  it("builds a read-only snapshot expression for inbound messages", () => {
    const expression = buildDesktopSnapshotExpression();
    expect(expression).toContain("chat-message-row--opponent");
    expect(expression).toContain("groupChatId");
    expect(expression).toContain("split(/\\r?\\n/, 1)");
    expect(expression).not.toContain(".click()");
    expect(expression).not.toContain("Input.insertText");
  });

  it("persists and reloads dedupe ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-desktop-test-"));
    const statePath = join(directory, "state.json");
    const first = new DesktopDedupeStore(statePath, 3);
    expect(await first.load()).toBe(false);
    await first.baseline(["one", "two"]);
    await first.add("three");
    await first.add("four");
    const second = new DesktopDedupeStore(statePath, 3);
    expect(await second.load()).toBe(true);
    expect(second.has("one")).toBe(false);
    expect(second.has("two")).toBe(true);
    expect(second.has("four")).toBe(true);
    const raw = JSON.parse(await readFile(statePath, "utf8")) as {
      seen: string[];
    };
    expect(raw.seen).toEqual(["two", "three", "four"]);
  });
});
