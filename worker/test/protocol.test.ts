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

  it("escapes HTML-sensitive characters", () => {
    const escaped = escapeHtml(`<script>alert("x")</script>&'`);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
  });
});
