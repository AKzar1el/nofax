import { describe, expect, it } from "vitest";
import { routeRequest } from "../src/index";
import type { Env } from "../src/env";

function env(): Env {
  return {
    REQUESTS: {
      getByName: () => ({ getRequest: async () => null, listPending: async () => [] })
    } as unknown as DurableObjectNamespace,
    NOFAX_REMOTE_KEY: "remote_key_abcdefghijklmnopqrstuvwxyz123456",
    NOFAX_MCP_HOSTNAME: "nofax.example",
    NTFY_TOPIC: "nofax_abcdefghijklmnopqrstuvwxyz123456"
  };
}

const ctx = {} as ExecutionContext;

describe("bounded remote Worker router", () => {
  it("serves a secret-free health check", async () => {
    const response = await routeRequest(new Request("https://nofax.example/healthz"), env(), ctx, {
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("returns 404 for unknown routes without leaking secrets", async () => {
    const response = await routeRequest(new Request("https://nofax.example/nope"), env(), ctx, {
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(env().NOFAX_REMOTE_KEY);
  });

  it("requires Bearer auth on /mcp and returns 401 without invoking MCP", async () => {
    let calls = 0;
    const response = await routeRequest(new Request("https://nofax.example/mcp"), env(), ctx, {
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
      mcpImpl: async (request) => {
        seenPath = new URL(request.url).pathname;
        return new Response("mcp-ok");
      }
    });
    expect(response.status).toBe(200);
    expect(seenPath).toBe("/mcp");
    expect(await response.text()).toBe("mcp-ok");
  });

  it("requires a configured exact MCP hostname before invoking the handler", async () => {
    let calls = 0;
    const response = await routeRequest(
      new Request("https://nofax.example/mcp", {
        headers: { authorization: `Bearer ${env().NOFAX_REMOTE_KEY}` }
      }),
      { ...env(), NOFAX_MCP_HOSTNAME: undefined },
      ctx,
      { mcpImpl: async () => { calls += 1; return new Response("unexpected"); } }
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("rejects foreign and malformed Host and Origin headers before MCP execution", async () => {
    const cases = [
      { host: "foreign.example" },
      { host: "probe@nofax.example" },
      { host: "nofax.example,foreign.example" },
      { origin: "https://foreign.example" },
      { origin: "https://probe@nofax.example" },
      { origin: "null" },
      { origin: "https://nofax.example/path" },
      { origin: "http://nofax.example" }
    ];
    for (const entry of cases) {
      let calls = 0;
      const headers = new Headers({ authorization: `Bearer ${env().NOFAX_REMOTE_KEY}` });
      if (entry.host) headers.set("host", entry.host);
      if (entry.origin) headers.set("origin", entry.origin);
      const response = await routeRequest(
        new Request("https://nofax.example/mcp", { headers }),
        env(),
        ctx,
        { mcpImpl: async () => { calls += 1; return new Response("unexpected"); } }
      );
      expect(response.status, JSON.stringify(entry)).toBe(403);
      expect(calls, JSON.stringify(entry)).toBe(0);
    }
  });

  it("accepts authenticated originless CLI requests and exact same-origin browser requests", async () => {
    for (const origin of [null, "https://nofax.example"]) {
      const headers = new Headers({
        authorization: `Bearer ${env().NOFAX_REMOTE_KEY}`,
        host: "nofax.example"
      });
      if (origin) headers.set("origin", origin);
      let calls = 0;
      const response = await routeRequest(new Request("https://nofax.example/mcp", { headers }), env(), ctx, {
        mcpImpl: async () => { calls += 1; return new Response("mcp-ok"); }
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(1);
    }
  });

  it("serves authenticated MCP initialization through the real v2 HTTP handler", async () => {
    const response = await routeRequest(new Request("https://nofax.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env().NOFAX_REMOTE_KEY}`,
        host: "nofax.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-11-25", capabilities: {},
          clientInfo: { name: "nofax-worker-regression", version: "1.0.0" }
        }
      })
    }), env(), ctx);
    const body = await response.text();
    expect(response.status, body.slice(0, 300)).toBe(200);
    expect(body).toContain("protocolVersion");
    expect(body).toContain("nofax");
  });
  it("normalizes capability-path MCP auth before invoking the MCP handler", async () => {
    let seenUrl = "";
    const key = env().NOFAX_REMOTE_KEY;
    const response = await routeRequest(new Request(`https://nofax.example/mcp/${encodeURIComponent(key)}`), env(), ctx, {
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
      mcpImpl: async () => { calls += 1; return new Response("mcp"); }
    });
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  it("hard-rejects former phone callback and Telegram webhook routes", async () => {
    let sideEffectCalls = 0;
    const overrides = {
      callbackImpl: async () => { sideEffectCalls += 1; return new Response("callback-ok"); },
      telegramWebhookImpl: async () => { sideEffectCalls += 1; return new Response("telegram-ok"); },
      mcpImpl: async () => new Response("unexpected", { status: 500 })
    } as any;

    const refine = await routeRequest(
      new Request("https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456"),
      env(),
      ctx,
      overrides
    );
    const telegram = await routeRequest(
      new Request("https://nofax.example/telegram/webhook", { method: "POST" }),
      env(),
      ctx,
      overrides
    );

    expect(refine.status).toBe(404);
    expect(telegram.status).toBe(404);
    expect(sideEffectCalls).toBe(0);
  });
});
