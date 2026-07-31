import { describe, expect, it } from "vitest";

import {
  type DesktopDeliveryJournal,
  reconcileDesktopDeliveryEntry,
} from "./desktop-delivery-journal.js";

function journal(): DesktopDeliveryJournal {
  return { version: 1, initializedAt: 100, entries: {} };
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
          text: "answer",
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
          text: "answer",
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
          text: "first",
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
});
