import { describe, expect, it } from "vitest";
import { renderRefineForm, renderResultPage } from "../src/mobile";

function assertSecurityHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("style-src 'unsafe-inline'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
}

describe("mobile refine page", () => {
  it("renders a no-JS escaped refinement form with strict security headers", async () => {
    const response = renderRefineForm({
      token: "token_abcdefghijklmnopqrstuvwxyz1234567890",
      title: `<script>alert("x")</script>`,
      message: "Release <b>now</b> & confirm"
    });
    expect(response.status).toBe(200);
    assertSecurityHeaders(response);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("Release &lt;b&gt;now&lt;/b&gt; &amp; confirm");
    expect(html).toContain('action="/r/token_abcdefghijklmnopqrstuvwxyz1234567890/refine"');
    expect(html).toContain('name="text"');
    expect(html).toContain('maxlength="2000"');
    expect(html).toContain("required");
    expect(html).not.toMatch(/<script|src=|@import|url\(/i);
  });

  it("renders terminal result pages with the same no-store security policy", async () => {
    const response = renderResultPage("Approved", "The response was recorded.");
    expect(response.status).toBe(200);
    assertSecurityHeaders(response);
    const html = await response.text();
    expect(html).toContain("Approved");
    expect(html).toContain("The response was recorded.");
  });
});
