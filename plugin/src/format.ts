/**
 * Text formatting utilities for eXpress (BotX API).
 *
 * BotX notifications support plain text. This module provides
 * minimal markdown-to-plain-text conversion and text utilities.
 */

/**
 * Convert markdown to plain text for BotX notifications.
 * Strips markdown formatting characters while preserving readability.
 */
export function toPlainText(text: string): string {
  return (
    text
      // Bold **text** → text
      .replace(/\*\*(.*?)\*\*/g, "$1")
      // Italic *text* or _text_ → text
      .replace(/(?<!\w)\*(.*?)\*(?!\w)/g, "$1")
      .replace(/(?<!\w)_(.*?)_(?!\w)/g, "$1")
      // Strikethrough ~~text~~ → text
      .replace(/~~(.*?)~~/g, "$1")
      // Code blocks ```text``` → text (must come before inline code)
      .replace(/```[\s\S]*?```/g, (m) => {
        const inner = m.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
        return inner.trim();
      })
      // Inline code `text` → text
      .replace(/`([^`]+)`/g, "$1")
      // Links [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      // Headers # → (strip)
      .replace(/^#{1,6}\s+/gm, "")
      // Blockquotes > → (strip)
      .replace(/^>\s+/gm, "")
      // Horizontal rules --- → —
      .replace(/^---+$/gm, "—")
      // List markers - or * → •
      .replace(/^[\s]*[-*]\s+/gm, "• ")
      // Numbered lists 1. → keep
      // Strip extra whitespace
      .trim()
  );
}

/**
 * Chunk text into pieces no longer than `limit` characters.
 * Tries to break at paragraph/line boundaries.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > limit) {
      if (current) chunks.push(current.trim());
      // If single line exceeds limit, hard-split
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          chunks.push(line.slice(i, i + limit));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
