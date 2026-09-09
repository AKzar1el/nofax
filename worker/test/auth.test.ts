import { describe, expect, it } from "vitest";
import { authorizeMcpRequest, constantTimeEqual } from "../src/auth";
import type { Env } from "../src/env";

function env(): Env {
  return {
    REQUESTS: {} as DurableObjectNamespace,
    NTFY_TOPIC: "topic",
    NTFY_SERVER: "https://ntfy.sh",
    NOFAX_REMOTE_KEY: "remote_key_abcdefghijklmnopqrstuvwxyz123456"
  };
}

describe("remote MCP authentication", () => {
  it("uses equal-length constant-time byte comparison", () => {
    expect(constantTimeEqual("same-value", "same-value")).toBe(true);
    expect(constantTimeEqual("same-value", "diff-value")).toBe(false);
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
  });

  it("rejects missing or wrong bearer credentials on /mcp", () => {
    expect(authorizeMcpRequest(new Request("https://nofax.example/mcp"), env()).authorized).toBe(false);
    expect(authorizeMcpRequest(new Request("https://nofax.example/mcp", {
      headers: { authorization: "Bearer wrong_key_abcdefghijklmnopqrstuvwxyz123456" }
    }), env()).authorized).toBe(false);
  });

  it("accepts the exact bearer credential and preserves /mcp", () => {
    const result = authorizeMcpRequest(new Request("https://nofax.example/mcp", {
      headers: { authorization: `Bearer ${env().NOFAX_REMOTE_KEY}` }
    }), env());
    expect(result.authorized).toBe(true);
    expect(new URL(result.normalizedRequest.url).pathname).toBe("/mcp");
  });

  it("accepts exact capability-path auth and normalizes it to /mcp", () => {
    const key = env().NOFAX_REMOTE_KEY;
    const result = authorizeMcpRequest(new Request(`https://nofax.example/mcp/${encodeURIComponent(key)}?x=1`), env());
    expect(result.authorized).toBe(true);
    const url = new URL(result.normalizedRequest.url);
    expect(url.pathname).toBe("/mcp");
    expect(url.search).toBe("?x=1");
    expect(result.normalizedRequest.url).not.toContain(key);
  });

  it("rejects wrong or malformed capability-path credentials", () => {
    expect(authorizeMcpRequest(new Request("https://nofax.example/mcp/wrong_key_abcdefghijklmnopqrstuvwxyz123456"), env()).authorized).toBe(false);
    expect(authorizeMcpRequest(new Request("https://nofax.example/mcp/a/b"), env()).authorized).toBe(false);
    expect(authorizeMcpRequest(new Request("https://nofax.example/not-mcp"), env()).authorized).toBe(false);
  });
});
