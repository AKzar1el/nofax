import { describe, expect, it } from "vitest";
import { routeRequest } from "../src/index";
import type { Env } from "../src/env";

function env(): Env {
  return {
    REQUESTS: {} as DurableObjectNamespace,
    NTFY_TOPIC: "topic",
    NTFY_SERVER: "https://ntfy.sh",
    NOFAX_REMOTE_KEY: "remote_key_abcdefghijklmnopqrstuvwxyz123456"
  };
}

const ctx = {} as ExecutionContext;

describe("remote Worker router", () => {
  it("serves a secret-free health check", async () => {
    const response = await routeRequest(new Request("https://nofax.example/healthz"), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("returns 404 for unknown routes without leaking secrets", async () => {
    const response = await routeRequest(new Request("https://nofax.example/nope"), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(env().NOFAX_REMOTE_KEY);
  });

  it("requires Bearer auth on /mcp and returns 401 without invoking MCP", async () => {
    let calls = 0;
    const response = await routeRequest(new Request("https://nofax.example/mcp"), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async () => { calls += 1; return new Response("mcp"); }
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(calls).toBe(0);
  });

  it("forwards an authorized Bearer request to MCP", async () => {
    let seenPath = "";
    const response = await routeRequest(new Request("https://nofax.example/mcp", {
      headers: { authorization: `Bearer ${env().NOFAX_REMOTE_KEY}` }
    }), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async (request) => {
        seenPath = new URL(request.url).pathname;
        return new Response("mcp-ok");
      }
    });
    expect(response.status).toBe(200);
    expect(seenPath).toBe("/mcp");
    expect(await response.text()).toBe("mcp-ok");
  });

  it("normalizes capability-path MCP auth before invoking the MCP handler", async () => {
    let seenUrl = "";
    const key = env().NOFAX_REMOTE_KEY;
    const response = await routeRequest(new Request(`https://nofax.example/mcp/${encodeURIComponent(key)}`), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async (request) => {
        seenUrl = request.url;
        return new Response("mcp-ok");
      }
    });
    expect(response.status).toBe(200);
    expect(new URL(seenUrl).pathname).toBe("/mcp");
    expect(seenUrl).not.toContain(key);
  });

  it("rejects a wrong capability path without invoking MCP", async () => {
    let calls = 0;
    const response = await routeRequest(new Request("https://nofax.example/mcp/wrong_key_abcdefghijklmnopqrstuvwxyz123456"), env(), ctx, {
      callbackImpl: async () => new Response("unexpected", { status: 500 }),
      mcpImpl: async () => { calls += 1; return new Response("mcp"); }
    });
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  it("routes phone callback capabilities without requiring the MCP key", async () => {
    let callbackCalls = 0;
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
    const response = await routeRequest(new Request(`https://nofax.example/r/${token}`), env(), ctx, {
      callbackImpl: async (request) => {
        callbackCalls += 1;
        expect(new URL(request.url).pathname).toBe(`/r/${token}`);
        return new Response("callback-ok");
      },
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    });
    expect(response.status).toBe(200);
    expect(callbackCalls).toBe(1);
    expect(await response.text()).toBe("callback-ok");
  });
});
