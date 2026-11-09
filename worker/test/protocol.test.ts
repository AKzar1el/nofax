import { describe, expect, it } from "vitest";
import {
  boundText,
  createCallbackToken,
  createRequestId,
  escapeHtml,
  hashCallbackToken
} from "../src/protocol";

describe("worker protocol", () => {
  it("creates high-entropy URL-safe identifiers", () => {
    expect(createRequestId()).toMatch(/^nfx_[A-Za-z0-9_-]{24,}$/);
    expect(createCallbackToken()).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("hashes callback tokens deterministically without retaining the raw token", async () => {
    const digest = await hashCallbackToken("abc");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(await hashCallbackToken("abc"));
    expect(digest).not.toContain("abc");
  });

  it("bounds user-visible text and rejects blanks", () => {
    expect(boundText("  hello  ", 10, "MESSAGE")).toBe("hello");
    expect(() => boundText("   ", 10, "MESSAGE")).toThrow(/NOFAX_MESSAGE_REQUIRED/);
    expect(boundText("abcdefghijk", 10, "MESSAGE").length).toBeLessThanOrEqual(10);
  });

  it("rejects malformed UTF-16 rather than silently replacing request text", () => {
    for (const input of ["Allow\ud800now", "Deny\udc00now", "\ud800"]) {
      expect(() => boundText(input, 120, "TITLE")).toThrow("NOFAX_TITLE_INVALID_UTF8");
      expect(() => boundText(input, 20, "MESSAGE")).toThrow("NOFAX_MESSAGE_INVALID_UTF8");
    }
    expect(boundText("Review \ud83d\ude80", 120, "TITLE")).toBe("Review \ud83d\ude80");
  });

  it("does not split astral Unicode when truncating user-visible text", () => {
    const marker = "\u2026[truncated]";
    const max = 20;
    const cut = max - marker.length;
    const result = boundText(`${"a".repeat(cut - 1)}\u{1F680}${"z".repeat(30)}`, max, "MESSAGE");
    const beforeMarker = result.slice(0, -marker.length);
    const lastCodeUnit = beforeMarker.charCodeAt(beforeMarker.length - 1);

    expect(result.endsWith(marker)).toBe(true);
    expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
  });

  it("escapes HTML-sensitive characters", () => {
    const escaped = escapeHtml(`<script>alert("x")</script>&'`);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
  });
});
