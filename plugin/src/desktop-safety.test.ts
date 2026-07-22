import { describe, expect, it } from "vitest";

import {
  DesktopDispatchRateLimiter,
  isDesktopAttachmentMetadataCompatible,
  redactDesktopError,
  selectDesktopInboundBatch,
  selectDesktopInboundBatchResilient,
} from "./desktop-safety.js";

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const senderId = id("99");
const limits = { expectedSenderId: senderId, maxMediaBytes: 1024 };
const textMessage = (suffix: string, text: string) => ({
  id: id(suffix),
  senderId,
  type: "text" as const,
  text,
});

describe("eXpress desktop safety controls", () => {
  it("builds a deduplicated bounded queue without retaining message whitespace", () => {
    const seen = new Set([id("1")]);
    expect(
      selectDesktopInboundBatch(
        [
          textMessage("1", "old"),
          textMessage("2", "  new  "),
          textMessage("2", "duplicate"),
        ],
        (messageId) => seen.has(messageId),
        limits,
      ),
    ).toEqual([textMessage("2", "new")]);
  });

  it("fails closed on malformed ids, oversized text, and queue overflow", () => {
    expect(() =>
      selectDesktopInboundBatch(
        [{ ...textMessage("3", "x"), id: "bad" }],
        () => false,
        limits,
      ),
    ).toThrow(/id is invalid/);
    expect(() =>
      selectDesktopInboundBatch(
        [textMessage("3", "x".repeat(32_769))],
        () => false,
        limits,
      ),
    ).toThrow(/safety limit/);
    expect(() =>
      selectDesktopInboundBatch(
        [textMessage("4", "a"), textMessage("5", "b")],
        () => false,
        limits,
        1,
      ),
    ).toThrow(/capacity/);
  });

  it("accepts bounded document metadata from only the exact sender", () => {
    const document = {
      id: id("6"),
      senderId,
      type: "document" as const,
      text: "caption",
      attachment: {
        fileId: id("6"),
        fileName: "brief.pdf",
        fileSize: 512,
        mimeType: "APPLICATION/PDF",
        kind: "file" as const,
      },
    };
    expect(selectDesktopInboundBatch([document], () => false, limits)).toEqual([
      {
        ...document,
        attachment: { ...document.attachment, mimeType: "application/pdf" },
      },
    ]);

    expect(() =>
      selectDesktopInboundBatch(
        [{ ...document, senderId: id("98") }],
        () => false,
        limits,
      ),
    ).toThrow(/sender is not allowlisted/);
    expect(() =>
      selectDesktopInboundBatch(
        [
          {
            ...document,
            attachment: { ...document.attachment, fileName: "../secret" },
          },
        ],
        () => false,
        limits,
      ),
    ).toThrow(/name is unsafe/);
    expect(() =>
      selectDesktopInboundBatch(
        [
          {
            ...document,
            attachment: { ...document.attachment, fileSize: 1025 },
          },
        ],
        () => false,
        limits,
      ),
    ).toThrow(/exceeds/);
    expect(() =>
      selectDesktopInboundBatch(
        [
          {
            ...document,
            attachment: { ...document.attachment, kind: "image" as const },
          },
        ],
        () => false,
        limits,
      ),
    ).toThrow(/kind is inconsistent/);
  });

  it("isolates one malformed attachment and keeps the later event queued", () => {
    const poison = {
      id: id("7"),
      senderId,
      type: "voice" as const,
      text: "",
      attachment: {
        fileId: id("7"),
        fileName: "../voice.m4a",
        fileSize: 512,
        mimeType: "audio/m4a",
        kind: "audio" as const,
      },
    };
    const healthy = textMessage("8", "later");
    const batch = selectDesktopInboundBatchResilient(
      [poison, healthy],
      () => false,
      limits,
    );
    expect(batch.queued).toEqual([healthy]);
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]?.message.id).toBe(poison.id);
    expect(batch.rejected[0]?.error).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/unsafe/) }),
    );
  });

  it.each([
    ["document", "brief.doc", "application/msword"],
    [
      "document",
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["document", "brief.pdf", "application/pdf"],
    ["document", "table.xls", "application/vnd.ms-excel"],
    [
      "document",
      "table.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["document", "slides.ppt", "application/vnd.ms-powerpoint"],
    [
      "document",
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["image", "photo.jpg", "image/jpeg"],
    ["audio", "clip.m4a", "audio/mp4"],
    ["voice", "voice.m4a", "audio/m4a"],
    ["video", "clip.mp4", "video/mp4"],
  ] as const)(
    "validates the allowlisted %s parser for %s",
    (type, name, mime) => {
      expect(isDesktopAttachmentMetadataCompatible(type, name, mime)).toBe(
        true,
      );
    },
  );

  it("rejects unsupported document and cross-media metadata", () => {
    expect(
      isDesktopAttachmentMetadataCompatible(
        "document",
        "payload.exe",
        "application/octet-stream",
      ),
    ).toBe(false);
    expect(
      isDesktopAttachmentMetadataCompatible("voice", "voice.m4a", "video/mp4"),
    ).toBe(false);
    expect(
      isDesktopAttachmentMetadataCompatible(
        "voice",
        "payload.docx",
        "application/octet-stream",
      ),
    ).toBe(false);
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
