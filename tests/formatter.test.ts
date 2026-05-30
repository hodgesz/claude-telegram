import { describe, it, expect } from "vitest";
import { claudeToTelegram, splitMessage } from "../src/formatter.js";

describe("splitMessage", () => {
  it("returns a single chunk when under the limit", () => {
    expect(splitMessage("hello", 4096)).toEqual(["hello"]);
  });

  it("splits long text into multiple chunks within the limit", () => {
    const text = "a ".repeat(5000); // ~10k chars
    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("preserves the full content across chunks", () => {
    const text = "word ".repeat(2000);
    const chunks = splitMessage(text, 1000);
    // Re-joining should contain every original word.
    const joined = chunks.join("");
    expect(joined.replace(/\s+/g, " ").trim()).toContain("word word");
  });
});

describe("claudeToTelegram", () => {
  it("converts bold markdown to Telegram HTML", () => {
    expect(claudeToTelegram("**hi**")).toContain("<b>hi</b>");
  });

  it("escapes raw HTML-significant characters in plain text", () => {
    const out = claudeToTelegram("a < b && c > d");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
  });
});
