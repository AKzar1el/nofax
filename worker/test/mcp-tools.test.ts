import { describe, expect, it } from "vitest";
import { createRemoteToolHandlers } from "../src/mcp-tools";
import type { Env } from "../src/env";

type Stored = {
  requestId: string;
  kind: "approval" | "choice" | "refinement";
  status: "pending" | "resolved";
  title: string;
  message: string;
  allowed: string[];
  callbackHash: string;
  createdAt: number;
  expiresAt: number;
  decision?: string;
  text?: string;
  resolvedAt?: number;
};

function env(): Env {
  return {
    REQUESTS: {} as DurableObjectNamespace,
    NOFAX_REMOTE_KEY: "remote-key"
  };
}

function pending(overrides: Partial<Stored> = {}): Stored {
  return {
    requestId: "nfx_abcdefghijklmnopqrstuvwx",
    kind: "approval",
    status: "pending",
    title: "Deploy?",
    message: "Release ready",
    allowed: ["allow", "deny"],
    callbackHash: "a".repeat(64),
    createdAt: 1_000,
    expiresAt: 86_401_000,
    ...overrides
  };
}

describe("read-only remote MCP tool handlers", () => {
  it("exposes only getRequest and listPending", () => {
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: {
        async getRequest() { return null; },
        async listPending() { return []; }
      } as never,
      nowImpl: () => 2_000
    });

    expect(Object.keys(handlers).sort()).toEqual(["getRequest", "listPending"]);
  });

  it("returns a safe request projection without callback or prompt material", async () => {
    const request = pending({
      status: "resolved",
      decision: "allow",
      resolvedAt: 2_000
    });
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: {
        async getRequest() { return request; },
        async listPending() { return []; }
      } as never,
      nowImpl: () => 3_000
    });

    const result = await handlers.getRequest({ requestId: request.requestId });
    expect(result).toEqual({
      status: "ok",
      request: {
        requestId: request.requestId,
        kind: "approval",
        status: "resolved",
        createdAt: new Date(1_000).toISOString(),
        resolvedAt: new Date(2_000).toISOString(),
        decision: "allow"
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/callbackHash|allowed|message|title/);
  });

  it("lists bounded safe pending projections through read-only store methods", async () => {
    const request = pending();
    let seenLimit: number | undefined;
    let seenNow: number | undefined;
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: {
        async getRequest() { return request; },
        async listPending(limit?: number, nowMs?: number) {
          seenLimit = limit;
          seenNow = nowMs;
          return [request];
        }
      } as never,
      nowImpl: () => 2_000
    });

    const result = await handlers.listPending({ limit: 10 });
    expect(seenLimit).toBe(10);
    expect(seenNow).toBe(2_000);
    expect(result).toEqual({
      status: "ok",
      requests: [{
        requestId: request.requestId,
        kind: "approval",
        status: "pending",
        createdAt: new Date(1_000).toISOString()
      }]
    });
  });
});
