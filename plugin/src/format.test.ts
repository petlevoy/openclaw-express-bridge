/**
 * Tests for text formatting utilities
 */

import { describe, expect, it } from "vitest";

import { chunkText, toPlainText } from "./format.js";

describe("format", () => {
  describe("toPlainText", () => {
    it("should strip bold markers", () => {
      expect(toPlainText("**bold text**")).toBe("bold text");
    });

    it("should strip italic markers", () => {
      expect(toPlainText("*italic*")).toBe("italic");
    });

    it("should strip strikethrough markers", () => {
      expect(toPlainText("~~struck~~")).toBe("struck");
    });

    it("should strip inline code markers", () => {
      expect(toPlainText("`code`")).toBe("code");
    });

    it("should strip code block markers", () => {
      expect(toPlainText("```\ncode block\n```")).toBe("code block");
    });

    it("should convert links to text (url) format", () => {
      expect(toPlainText("[click](https://example.com)")).toBe(
        "click (https://example.com)",
      );
    });

    it("should strip header markers", () => {
      expect(toPlainText("# Header\nText")).toBe("Header\nText");
    });

    it("should convert list markers to bullets", () => {
      expect(toPlainText("- item 1\n- item 2")).toBe("• item 1\n• item 2");
    });

    it("should pass through plain text unchanged", () => {
      expect(toPlainText("just plain text")).toBe("just plain text");
    });
  });

  describe("chunkText", () => {
    it("should return single chunk for short text", () => {
      expect(chunkText("short text", 100)).toEqual(["short text"]);
    });

    it("should split at line boundaries", () => {
      const text = "line1\nline2\nline3";
      const chunks = chunkText(text, 12);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("\n")).toContain("line1");
    });

    it("should hard-split long lines", () => {
      const longLine = "a".repeat(100);
      const chunks = chunkText(longLine, 30);
      expect(chunks.length).toBe(4); // 30 + 30 + 30 + 10
      expect(chunks[0]).toHaveLength(30);
    });

    it("should handle empty text", () => {
      expect(chunkText("", 100)).toEqual([""]);
    });
  });
});
