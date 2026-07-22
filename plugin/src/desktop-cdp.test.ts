import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedExpressAccount } from "./accounts.js";
import {
  buildDesktopAttachmentChunkExpression,
  buildDesktopAttachmentStartExpression,
  buildDesktopAttachmentStatusExpression,
  buildDesktopSnapshotExpression,
  DESKTOP_DOCUMENT_INPUT_SELECTOR,
  DESKTOP_IMAGE_INPUT_SELECTOR,
  DESKTOP_VIDEO_INPUT_SELECTOR,
  DesktopDedupeStore,
  desktopInputSelectorFor,
  isDesktopOutboundUnlocked,
  normalizeLoopbackCdpSocketUrl,
  normalizeLoopbackCdpUrl,
  validateDesktopOutboundFile,
} from "./desktop-cdp.js";

describe("eXpress desktop CDP bridge", () => {
  it("accepts only loopback CDP endpoints", () => {
    expect(normalizeLoopbackCdpUrl("http://127.0.0.1:18997/")).toBe(
      "http://127.0.0.1:18997",
    );
    expect(() => normalizeLoopbackCdpUrl("https://example.com:18997")).toThrow(
      /loopback/,
    );
    expect(() =>
      normalizeLoopbackCdpUrl("http://user:pass@127.0.0.1:18997"),
    ).toThrow(/credentials/);
    expect(
      normalizeLoopbackCdpSocketUrl(
        "ws://127.0.0.1:18997/devtools/page/abc",
        "http://localhost:18997",
      ),
    ).toBe("ws://127.0.0.1:18997/devtools/page/abc");
    expect(() =>
      normalizeLoopbackCdpSocketUrl(
        "ws://example.com:18997/devtools/page/abc",
        "http://127.0.0.1:18997",
      ),
    ).toThrow(/loopback/);
    expect(() =>
      normalizeLoopbackCdpSocketUrl(
        "ws://127.0.0.1:19999/devtools/page/abc",
        "http://127.0.0.1:18997",
      ),
    ).toThrow(/protocol and port/);
  });

  it("builds a read-only snapshot expression for inbound messages", () => {
    const expression = buildDesktopSnapshotExpression();
    expect(expression).toContain("chat-message-row--opponent");
    expect(expression).toContain("groupChatId");
    expect(expression).toContain(
      "'document', 'image', 'audio', 'voice', 'video'",
    );
    expect(expression).toContain("sender?.userHuid");
    expect(expression).toContain("fileMimeType");
    expect(expression).toContain("split(/\\r?\\n/, 1)");
    expect(expression).not.toContain(".click()");
    expect(expression).not.toContain("Input.insertText");
  });

  it("uses the official MessageEntry onClick contract and blob URLs", () => {
    const messageId = "00000000-0000-4000-8000-000000000001";
    const expressions = [
      buildDesktopAttachmentStartExpression(messageId),
      buildDesktopAttachmentStatusExpression(messageId),
      buildDesktopAttachmentChunkExpression(messageId, 0, 1024),
    ].join("\n");
    expect(expressions).toContain("downloadToBlob: true");
    expect(expressions).toContain(
      "found.documentOnClick({ downloadToBlob: true })",
    );
    expect(expressions).toContain(
      "found.loadAttachment({ message: found.message, downloadToBlob: true })",
    );
    expect(expressions).toContain("componentName === 'MessageEntryDocument'");
    expect(expressions).toContain("found.message.payload?.payload?.fileBlob");
    expect(expressions).toContain(
      "found.message.payload?.payload?.fileBlob ?? found.message.payload?.fileBlob",
    );
    expect(expressions).toContain("value.startsWith('blob:file:')");
    expect(expressions).toContain("blob.slice(0, 1024)");
    expect(expressions).not.toMatch(/cookie|authorization|bearer/i);
    expect(() =>
      buildDesktopAttachmentChunkExpression(messageId, -1, 1),
    ).toThrow(/offset/);
  });

  it("targets only the official client's exact attachment inputs", () => {
    expect(DESKTOP_DOCUMENT_INPUT_SELECTOR).toBe(
      'input[id^="document-input"][type="file"][accept="*"]',
    );
    expect(DESKTOP_IMAGE_INPUT_SELECTOR).toBe(
      'input[id^="image-input"][type="file"][accept="image/gif,image/jpeg,image/png,image/vnd.microsoft.icon,image/webp,image/bmp"]',
    );
    expect(DESKTOP_VIDEO_INPUT_SELECTOR).toBe(
      'input[id^="video-input"][type="file"][accept="video/*"]',
    );
    expect(desktopInputSelectorFor("document")).toBe(
      DESKTOP_DOCUMENT_INPUT_SELECTOR,
    );
    expect(desktopInputSelectorFor("image")).toBe(DESKTOP_IMAGE_INPUT_SELECTOR);
    expect(desktopInputSelectorFor("video")).toBe(DESKTOP_VIDEO_INPUT_SELECTOR);
  });

  it("accepts bounded local regular files only inside allowed roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-test-"));
    const allowed = join(directory, "allowed");
    const outside = join(directory, "outside.docx");
    const filePath = join(allowed, "brief.docx");
    const linked = join(allowed, "linked.docx");
    await mkdir(allowed);
    await writeFile(filePath, "docx-test");
    await writeFile(outside, "outside");
    await symlink(outside, linked);

    await expect(
      validateDesktopOutboundFile(filePath, 1, [allowed]),
    ).resolves.toMatchObject({ path: filePath, size: 9, kind: "document" });
    await expect(
      validateDesktopOutboundFile(outside, 1, [allowed]),
    ).rejects.toThrow(/outside allowed roots/);
    await expect(
      validateDesktopOutboundFile(linked, 1, [allowed]),
    ).rejects.toThrow(/regular file/);

    const linkedDirectory = join(directory, "linked-directory");
    await symlink(allowed, linkedDirectory);
    await expect(
      validateDesktopOutboundFile(join(linkedDirectory, "brief.docx"), 1, [
        allowed,
      ]),
    ).rejects.toThrow(/contains a symlink/);
  });

  it("selects native image/video inputs and document fallback by extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-kind-test-"));
    const image = join(directory, "photo.png");
    const video = join(directory, "clip.mp4");
    const audio = join(directory, "voice.ogg");
    await writeFile(image, "image");
    await writeFile(video, "video");
    await writeFile(audio, "audio");

    await expect(
      validateDesktopOutboundFile(image, 1, [directory]),
    ).resolves.toMatchObject({ kind: "image" });
    await expect(
      validateDesktopOutboundFile(video, 1, [directory]),
    ).resolves.toMatchObject({ kind: "video" });
    await expect(
      validateDesktopOutboundFile(audio, 1, [directory]),
    ).resolves.toMatchObject({ kind: "document" });
  });

  it("rejects missing, non-regular, remote, and oversized media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-media-test-"));
    const nested = join(directory, "folder");
    const filePath = join(directory, "large.docx");
    await mkdir(nested);
    await writeFile(filePath, "too large");

    await expect(
      validateDesktopOutboundFile(join(directory, "missing.docx"), 1, [
        directory,
      ]),
    ).rejects.toThrow(/does not exist/);
    await expect(
      validateDesktopOutboundFile(nested, 1, [directory]),
    ).rejects.toThrow(/regular file/);
    await expect(
      validateDesktopOutboundFile("https://example.com/file.docx", 1, [
        directory,
      ]),
    ).rejects.toThrow(/local file/);
    await expect(
      validateDesktopOutboundFile(filePath, 0.000001, [directory]),
    ).rejects.toThrow(/exceeds/);
    await expect(
      validateDesktopOutboundFile(filePath, 101, [directory]),
    ).rejects.toThrow(/limit is invalid/);
    const credentialPath = join(directory, ".env.secrets");
    await writeFile(credentialPath, "not-a-real-secret");
    await expect(
      validateDesktopOutboundFile(credentialPath, 1, [directory]),
    ).rejects.toThrow(/credential-like/);
  });

  it("keeps both desktop outbound gates for document delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "express-gate-test-"));
    const switchPath = join(directory, "outbound.enabled");
    await writeFile(switchPath, "enabled\n");
    await chmod(switchPath, 0o600);
    const account = {
      mode: "desktop",
      config: {
        desktopOutboundEnabled: true,
        desktopOutboundSwitchPath: switchPath,
      },
    } as unknown as ResolvedExpressAccount;

    await expect(isDesktopOutboundUnlocked(account)).resolves.toBe(true);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: { ...account.config, desktopOutboundEnabled: false },
      }),
    ).resolves.toBe(false);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: join(directory, "missing"),
        },
      }),
    ).resolves.toBe(false);

    const linkedSwitch = join(directory, "linked.enabled");
    await symlink(switchPath, linkedSwitch);
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: linkedSwitch,
        },
      }),
    ).resolves.toBe(false);

    const looseSwitch = join(directory, "loose.enabled");
    await writeFile(looseSwitch, "enabled\n", { mode: 0o644 });
    await expect(
      isDesktopOutboundUnlocked({
        ...account,
        config: {
          ...account.config,
          desktopOutboundSwitchPath: looseSwitch,
        },
      }),
    ).resolves.toBe(false);
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
