import { describe, expect, it, vi } from "vitest";

import type { DesktopOutboundFile } from "./desktop-cdp.js";
import { desktopReplySender, desktopRoutePeer } from "./desktop-routing.js";

const chatA = {
  chatId: "00000000-0000-4000-8000-000000000001",
  chatTitle: "Alice",
  senderId: "00000000-0000-4000-8000-000000000011",
};
const chatB = {
  chatId: "00000000-0000-4000-8000-000000000002",
  chatTitle: "Bob",
  senderId: "00000000-0000-4000-8000-000000000022",
};

describe("desktop routing and reply isolation", () => {
  it("routes through the exact sender peer id", () => {
    expect(desktopRoutePeer(chatB)).toEqual({
      kind: "direct",
      id: chatB.senderId,
    });
  });

  it("cannot cross-send concurrent replies between event chats", async () => {
    const sendText = vi.fn().mockResolvedValue("message-id");
    const sendFile = vi.fn().mockResolvedValue("message-id");
    const client = { sendText, sendFile };
    const senderA = desktopReplySender(chatA, client);
    const senderB = desktopReplySender(chatB, client);
    const file = { path: "/tmp/a", size: 1 } as DesktopOutboundFile;

    await Promise.all([
      senderA.sendText("reply-a"),
      senderB.sendText("reply-b"),
      senderA.sendFile(file),
    ]);

    expect(sendText.mock.calls).toEqual([
      [chatA.chatId, "reply-a"],
      [chatB.chatId, "reply-b"],
    ]);
    expect(sendFile).toHaveBeenCalledWith(chatA.chatId, file);
  });
});
