import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DesktopDedupeStore, type DesktopMessage } from "./desktop-cdp.js";
import {
  DesktopInboundAttachmentError,
  processDesktopInboundEvent,
} from "./desktop-monitor.js";

const senderId = "00000000-0000-4000-8000-000000000099";
const message = (suffix: string, type: DesktopMessage["type"] = "document") =>
  ({
    id: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    senderId,
    type,
    text: "",
  }) satisfies DesktopMessage;

describe("desktop inbound event isolation", () => {
  it("does not reconnect for one attachment failure and continues the batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-event-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const poison = message("1", "voice");
    const healthy = message("2", "text");
    const diagnostics: string[] = [];

    await expect(
      processDesktopInboundEvent({
        message: poison,
        store,
        work: async () => {
          throw new DesktopInboundAttachmentError(
            new Error("desktop inbound attachment was not loaded"),
          );
        },
        onDiagnostic: (outcome, attempt, diagnostic) =>
          diagnostics.push(`${outcome}:${attempt}:${diagnostic}`),
      }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({
        message: healthy,
        store,
        work: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe("delivered");

    expect(store.has(poison.id)).toBe(false);
    expect(store.has(healthy.id)).toBe(true);
    expect(diagnostics).toEqual([
      "retry:1:desktop inbound attachment was not loaded",
    ]);
  });

  it("quarantines a poison id after bounded retries without replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-poison-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const poison = message("3", "audio");
    const work = async () => {
      throw new DesktopInboundAttachmentError(new Error("invalid audio blob"));
    };

    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("retry");
    await expect(
      processDesktopInboundEvent({ message: poison, store, work }),
    ).resolves.toBe("quarantined");
    expect(store.has(poison.id)).toBe(true);
  });

  it("still reconnects on transport or OpenClaw dispatch failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-global-test-"));
    const store = new DesktopDedupeStore(join(directory, "state.json"));
    await store.load();
    const inbound = message("4");

    await expect(
      processDesktopInboundEvent({
        message: inbound,
        store,
        work: async () => {
          throw new Error("desktop CDP connection closed");
        },
      }),
    ).rejects.toThrow("desktop CDP connection closed");
    expect(store.has(inbound.id)).toBe(false);
  });
});
