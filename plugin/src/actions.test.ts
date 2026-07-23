import { beforeEach, describe, expect, it, vi } from "vitest";

import { expressMessageActions } from "./actions.js";

const mocks = vi.hoisted(() => ({
  sendMedia: vi.fn().mockResolvedValue({ messageId: "attachment-id" }),
  sendText: vi.fn().mockResolvedValue({ messageId: "text-id" }),
}));

vi.mock("./accounts.js", () => ({
  listExpressAccountIds: vi.fn(() => ["default"]),
  resolveExpressAccount: vi.fn(() => ({
    accountId: "default",
    configured: true,
    enabled: true,
  })),
}));

vi.mock("./send.js", () => ({
  sendExpressMediaMessage: mocks.sendMedia,
  sendExpressMessage: mocks.sendText,
}));

describe("eXpress message actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "DOCX document",
      {
        text: "Отчёт",
        mediaUrl: "/tmp/express-outbound-regression.docx",
      },
    ],
    [
      "image",
      {
        text: "",
        mediaUrl: "/tmp/express-outbound-regression.png",
      },
    ],
    [
      "multiple attachments",
      {
        text: "Файлы",
        mediaUrls: ["/tmp/report.docx", "/tmp/preview.png"],
      },
    ],
  ])("keeps generic %s sends on the core outbound media path", (_, payload) => {
    const prepared = expressMessageActions.prepareSendPayload?.({
      ctx: { action: "send" } as never,
      to: "00000000-0000-4000-8000-000000000001",
      payload,
    });
    expect(prepared).toBe(payload);
  });

  it("does not claim non-send actions for the core outbound path", () => {
    const prepared = expressMessageActions.prepareSendPayload?.({
      ctx: { action: "react" } as never,
      to: "00000000-0000-4000-8000-000000000001",
      payload: { text: "ignored" },
    });
    expect(prepared).toBeNull();
  });

  it.each([
    ["media", "media"],
    ["filePath", "filePath"],
  ])(
    "legacy %s fallback sends the attachment and returns its real id",
    async (_, sourceKey) => {
      const result = await expressMessageActions.handleAction?.({
        action: "send",
        params: {
          to: "00000000-0000-4000-8000-000000000001",
          message: "",
          [sourceKey]: "/tmp/report.docx",
        },
        cfg: { channels: {} },
      } as never);
      expect(mocks.sendMedia).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
        "",
        "/tmp/report.docx",
        expect.objectContaining({ accountId: "default" }),
      );
      expect(JSON.stringify(result)).toContain("attachment-id");
      expect(JSON.stringify(result)).not.toContain('"messageId":""');
    },
  );

  it("fails closed when a legacy send has neither text nor media", async () => {
    await expect(
      expressMessageActions.handleAction?.({
        action: "send",
        params: {
          to: "00000000-0000-4000-8000-000000000001",
          message: "",
        },
        cfg: { channels: {} },
      } as never),
    ).rejects.toThrow(/requires a message or media/);
  });
});
