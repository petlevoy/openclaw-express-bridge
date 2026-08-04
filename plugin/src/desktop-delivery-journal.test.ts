import { describe, expect, it } from "vitest";

import {
  type DesktopDeliveryJournal,
  desktopDeliveryTextSha256,
  parseDesktopDeliveryJournal,
  pruneUnresolvedDesktopDeliveryEntries,
  reconcileDesktopDeliveryEntry,
} from "./desktop-delivery-journal.js";

function journal(): DesktopDeliveryJournal {
  return { version: 2, initializedAt: 100, entries: {} };
}

describe("reconcileDesktopDeliveryEntry", () => {
  it("proves a post-journal delivery was not sent when no dispatch exists", () => {
    expect(
      reconcileDesktopDeliveryEntry({
        journal: journal(),
        queueId: "queue",
        enqueuedAt: 101,
        chatId: "chat",
        expectedTexts: ["answer"],
      }),
    ).toEqual({ status: "not_sent" });
  });

  it("does not replay a legacy delivery without evidence", () => {
    expect(
      reconcileDesktopDeliveryEntry({
        journal: journal(),
        queueId: "queue",
        enqueuedAt: 99,
        chatId: "chat",
        expectedTexts: ["answer"],
      }),
    ).toMatchObject({ status: "unresolved" });
  });

  it("recognizes an exact message added after the recorded baseline", () => {
    const state = journal();
    state.entries.queue = {
      queueId: "queue",
      chatId: "chat",
      updatedAt: 102,
      attempts: [
        {
          id: "attempt",
          textSha256: desktopDeliveryTextSha256("answer"),
          baselineOwnMessageIds: ["before"],
          dispatchedAt: 102,
        },
      ],
    };
    expect(
      reconcileDesktopDeliveryEntry({
        journal: state,
        queueId: "queue",
        enqueuedAt: 101,
        chatId: "chat",
        expectedTexts: ["answer"],
        snapshot: {
          ownMessages: [
            { id: "before", senderId: "self", type: "text", text: "old" },
            { id: "after", senderId: "self", type: "text", text: "answer" },
          ],
        },
      }),
    ).toEqual({ status: "sent", messageIds: ["after"] });
  });

  it("proves no send when the baseline remains and no exact text appears", () => {
    const state = journal();
    state.entries.queue = {
      queueId: "queue",
      chatId: "chat",
      updatedAt: 102,
      attempts: [
        {
          id: "attempt",
          textSha256: desktopDeliveryTextSha256("answer"),
          baselineOwnMessageIds: ["before"],
          dispatchedAt: 102,
        },
      ],
    };
    expect(
      reconcileDesktopDeliveryEntry({
        journal: state,
        queueId: "queue",
        enqueuedAt: 101,
        chatId: "chat",
        expectedTexts: ["answer"],
        snapshot: {
          ownMessages: [
            { id: "before", senderId: "self", type: "text", text: "old" },
          ],
        },
      }),
    ).toEqual({ status: "not_sent" });
  });

  it("refuses a full replay after only part of a batch was sent", () => {
    const state = journal();
    state.entries.queue = {
      queueId: "queue",
      chatId: "chat",
      updatedAt: 102,
      attempts: [
        {
          id: "attempt",
          textSha256: desktopDeliveryTextSha256("first"),
          baselineOwnMessageIds: [],
          dispatchedAt: 102,
          messageId: "sent-first",
        },
      ],
    };
    expect(
      reconcileDesktopDeliveryEntry({
        journal: state,
        queueId: "queue",
        enqueuedAt: 101,
        chatId: "chat",
        expectedTexts: ["first", "second"],
      }),
    ).toMatchObject({ status: "unresolved" });
  });

  it("migrates a v1 journal without retaining plaintext", () => {
    const migrated = parseDesktopDeliveryJournal(
      JSON.stringify({
        version: 1,
        initializedAt: 100,
        entries: {
          queue: {
            queueId: "queue",
            chatId: "chat",
            updatedAt: 102,
            attempts: [
              {
                id: "attempt",
                text: "private answer",
                baselineOwnMessageIds: [],
                dispatchedAt: 102,
              },
            ],
          },
        },
      }),
    );
    expect(migrated.version).toBe(2);
    expect(migrated.entries.queue?.attempts[0]).toMatchObject({
      textSha256: desktopDeliveryTextSha256("private answer"),
    });
    expect(JSON.stringify(migrated)).not.toContain("private answer");
  });
});

describe("desktop delivery journal ageing", () => {
  const journal = (updatedAt: number, messageId?: string) => ({
    version: 2 as const,
    initializedAt: 0,
    entries: {
      "queue-one": {
        queueId: "queue-one",
        chatId: "00000000-0000-4000-8000-00000000aaaa",
        attempts: [
          {
            id: "attempt-one",
            textSha256: "sha",
            baselineOwnMessageIds: [],
            dispatchedAt: updatedAt,
            messageId,
          },
        ],
        updatedAt,
      },
    },
  });

  it("forgets an unconfirmed attempt that can no longer be reconciled", () => {
    const stale = journal(0);
    expect(
      pruneUnresolvedDesktopDeliveryEntries(stale, 48 * 60 * 60 * 1000),
    ).toBe(1);
    expect(Object.keys(stale.entries)).toEqual([]);
  });

  it("keeps a recent unconfirmed attempt so recovery can still resolve it", () => {
    const recent = journal(0);
    expect(pruneUnresolvedDesktopDeliveryEntries(recent, 60_000)).toBe(0);
    expect(Object.keys(recent.entries)).toEqual(["queue-one"]);
  });

  it("keeps confirmed evidence regardless of age", () => {
    const confirmed = journal(0, "message-one");
    expect(
      pruneUnresolvedDesktopDeliveryEntries(confirmed, 48 * 60 * 60 * 1000),
    ).toBe(0);
    expect(Object.keys(confirmed.entries)).toEqual(["queue-one"]);
  });
});
