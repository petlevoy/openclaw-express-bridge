import type {
  DesktopOutboundFile,
  ExpressDesktopClient,
} from "./desktop-cdp.js";
import type { DesktopChatConfig } from "./types.js";

export function desktopRoutePeer(chat: DesktopChatConfig): {
  kind: "direct";
  id: string;
} {
  return { kind: "direct", id: chat.senderId };
}

/**
 * Bind outbound delivery to the chat that produced the inbound event. The
 * caller cannot substitute a target id, which prevents cross-chat replies.
 */
export function desktopReplySender(
  chat: DesktopChatConfig,
  client: Pick<ExpressDesktopClient, "sendText" | "sendFile">,
) {
  return {
    sendText: (text: string) => client.sendText(chat.chatId, text),
    sendFile: (file: DesktopOutboundFile) => client.sendFile(chat.chatId, file),
  };
}
