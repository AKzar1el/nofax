import { describe, expect, it } from "vitest";
import { createRemoteToolHandlers, WAIT_REQUIRED } from "../src/mcp-tools";
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
    NTFY_TOPIC: "topic",
    NTFY_SERVER: "https://ntfy.sh",
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

describe("remote MCP tool handlers", () => {
  it("persists an approval before publishing and never returns callback capability material", async () => {
    const order: string[] = [];
    let stored: Stored | undefined;
    let published: Record<string, unknown> | undefined;
    const store = {
      async createRequest(input: Stored) { order.push("persist"); stored = { ...input, status: "pending" }; return stored; },
      async deleteRequest() { return true; },
      async getRequest() { return stored ?? null; },
      async listPending() { return stored ? [stored] : []; }
    };
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: store,
      createRequestIdImpl: () => "nfx_abcdefghijklmnopqrstuvwx",
      createCallbackTokenImpl: () => "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      hashCallbackTokenImpl: async () => "a".repeat(64),
      publishInteractiveNotificationImpl: async (input) => { order.push("publish"); published = input as unknown as Record<string, unknown>; },
      nowImpl: () => 1_000,
      sleepImpl: async () => {}
    });

    const result = await handlers.requestApproval({ title: "Deploy?", message: "Release ready", allowRefine: true });
    expect(order).toEqual(["persist", "publish"]);
    expect(stored?.allowed).toEqual(["allow", "refine", "deny"]);
    expect(stored?.expiresAt).toBe(86_401_000);
    expect(published?.callbackToken).toBe("callback_token_abcdefghijklmnopqrstuvwxyz123456");
    expect(result).toEqual({
      status: "pending",
      requestId: "nfx_abcdefghijklmnopqrstuvwx",
      mustWait: true,
      instruction: WAIT_REQUIRED("nfx_abcdefghijklmnopqrstuvwx")
    });
    expect(JSON.stringify(result)).not.toMatch(/callback|hash|remote-key/i);
  });

  it("deletes an orphaned request if phone delivery fails", async () => {
    const deleted: string[] = [];
    const store = {
      async createRequest(input: Stored) { return { ...input, status: "pending" }; },
      async deleteRequest(requestId: string) { deleted.push(requestId); return true; },
      async getRequest() { return null; },
      async listPending() { return []; }
    };
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: store,
      createRequestIdImpl: () => "nfx_abcdefghijklmnopqrstuvwx",
      createCallbackTokenImpl: () => "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      hashCallbackTokenImpl: async () => "a".repeat(64),
      publishInteractiveNotificationImpl: async () => { throw new Error("NOFAX_NTFY_PUBLISH_429"); },
      nowImpl: () => 1_000,
      sleepImpl: async () => {}
    });
    await expect(handlers.requestApproval({ message: "Release ready" })).rejects.toThrow(/NOFAX_NTFY_PUBLISH_429/);
    expect(deleted).toEqual(["nfx_abcdefghijklmnopqrstuvwx"]);
  });

  it("returns a mandatory repeat-wait instruction while a durable request remains pending", async () => {
    let now = 1_000;
    const request = pending();
    const store = {
      async createRequest() { return request; },
      async deleteRequest() { return false; },
      async getRequest() { return request; },
      async listPending() { return [request]; }
    };
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: store,
      nowImpl: () => now,
      sleepImpl: async (ms) => { now += ms; }
    });
    const result = await handlers.waitForResponse({ requestId: request.requestId, waitSeconds: 1 });
    expect(result).toEqual({
      status: "pending",
      requestId: request.requestId,
      mustWait: true,
      instruction: WAIT_REQUIRED(request.requestId)
    });
  });

  it("returns local-v0.2-compatible terminal allow, deny, refine, and choice semantics", async () => {
    const cases = [
      ["allow", undefined, "Human approved this request. The caller may continue only within its existing authority."],
      ["deny", undefined, "Human denied this request. Do not perform the guarded action."],
      ["refine", "Make it shorter.", "Apply the human refinement. If the resulting action still requires approval, create a new approval request and wait for that new terminal response before acting."],
      ["staging", undefined, "Human choice received. Apply only that explicit choice within the caller's existing authority."]
    ] as const;

    for (const [decision, text, instruction] of cases) {
      const request = pending({
        kind: decision === "staging" ? "choice" : decision === "refine" ? "refinement" : "approval",
        status: "resolved",
        allowed: [decision],
        decision,
        ...(text ? { text } : {}),
        resolvedAt: 2_000
      });
      const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
        storeImpl: {
          async createRequest() { return request; },
          async deleteRequest() { return false; },
          async getRequest() { return request; },
          async listPending() { return []; }
        },
        nowImpl: () => 3_000,
        sleepImpl: async () => {}
      });
      const result = await handlers.waitForResponse({ requestId: request.requestId, waitSeconds: 1 });
      expect(result.status).toBe("resolved");
      expect(result.decision).toBe(decision);
      expect(result.instruction).toBe(instruction);
      if (decision === "refine") expect(result.text).toBe(text);
    }
  });

  it("exposes safe request projections and one-way notify without creating a wait", async () => {
    const request = pending();
    let notified: Record<string, unknown> | undefined;
    const handlers = createRemoteToolHandlers(env(), "https://nofax.example", {
      storeImpl: {
        async createRequest() { return request; },
        async deleteRequest() { return false; },
        async getRequest() { return request; },
        async listPending() { return [request]; }
      },
      publishNotificationImpl: async (input) => { notified = input as unknown as Record<string, unknown>; },
      nowImpl: () => 2_000,
      sleepImpl: async () => {}
    });
    expect(await handlers.notify({ title: "Build", message: "Done" })).toEqual({ status: "sent" });
    expect(notified).toMatchObject({ title: "Build", message: "Done" });

    const single = await handlers.getRequest({ requestId: request.requestId });
    expect(single.request).toEqual({
      requestId: request.requestId,
      kind: "approval",
      status: "pending",
      createdAt: new Date(1_000).toISOString()
    });
    expect(JSON.stringify(single)).not.toMatch(/callbackHash|allowed|message|title/);

    const listed = await handlers.listPending({ limit: 10 });
    expect(listed.requests).toEqual([single.request]);
  });
});
