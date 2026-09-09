import { describe, expect, it } from "vitest";
import { handleCallback } from "../src/callbacks";
import type { Env } from "../src/env";
import { hashCallbackToken } from "../src/protocol";

type FakeStored = {
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

type ResolveResult = { request: FakeStored; newlyResolved: boolean } | null;

type FakeStore = {
  getByCallbackHash(callbackHash: string, nowMs: number): Promise<FakeStored | null>;
  resolveByCallbackHash(input: { callbackHash: string; decision: string; text?: string; nowMs: number }): Promise<ResolveResult>;
};

function pending(callbackHash: string, allowed = ["allow", "refine", "deny"]): FakeStored {
  return {
    requestId: "nfx_abcdefghijklmnopqrstuvwx",
    kind: "approval",
    status: "pending",
    title: "Deploy?",
    message: "Release ready",
    allowed,
    callbackHash,
    createdAt: 1_000,
    expiresAt: 100_000
  };
}

function envWithStore(store: FakeStore): Env {
  return {
    REQUESTS: {
      getByName: () => store
    } as unknown as DurableObjectNamespace,
    NTFY_TOPIC: "nofax_private_topic",
    NTFY_SERVER: "https://ntfy.sh",
    NOFAX_REMOTE_KEY: "must-never-appear-here"
  };
}

describe("remote phone callbacks", () => {
  it("GET refine hashes the capability token and renders only live refinable requests", async () => {
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
    const expectedHash = await hashCallbackToken(token);
    const seen: string[] = [];
    const store: FakeStore = {
      async getByCallbackHash(callbackHash) {
        seen.push(callbackHash);
        return pending(expectedHash);
      },
      async resolveByCallbackHash() {
        throw new Error("unexpected resolve");
      }
    };

    const response = await handleCallback(
      new Request(`https://nofax.example/r/${token}`),
      envWithStore(store),
      { nowImpl: () => 2_000 }
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([expectedHash]);
    expect(seen[0]).not.toContain(token);
    expect(await response.text()).toContain("What should I change?");
  });

  it("one-tap Allow resolves by hash and sends confirmation only after the first resolution", async () => {
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
    const expectedHash = await hashCallbackToken(token);
    const resolves: Array<Record<string, unknown>> = [];
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const resolved: FakeStored = {
      ...pending(expectedHash),
      status: "resolved",
      decision: "allow",
      resolvedAt: 2_000
    };
    const store: FakeStore = {
      async getByCallbackHash() { return null; },
      async resolveByCallbackHash(input) {
        resolves.push(input);
        return { request: resolved, newlyResolved: true };
      }
    };

    const response = await handleCallback(
      new Request(`https://nofax.example/r/${token}/allow`, { method: "POST" }),
      envWithStore(store),
      {
        nowImpl: () => 2_000,
        fetchImpl: async (input, init) => {
          fetchCalls.push({ url: String(input), body: String(init?.body ?? "") });
          return new Response("{}", { status: 200 });
        }
      }
    );
    expect(response.status).toBe(200);
    expect(resolves).toEqual([{ callbackHash: expectedHash, decision: "allow", nowMs: 2_000 }]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://ntfy.sh/");
    expect(fetchCalls[0].body).not.toContain(token);
    expect(fetchCalls[0].body).not.toContain("must-never-appear-here");
    expect(await response.text()).toMatch(/Approved/i);
  });

  it("does not overwrite or re-confirm an already terminal request", async () => {
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
    const expectedHash = await hashCallbackToken(token);
    const existing: FakeStored = {
      ...pending(expectedHash),
      status: "resolved",
      decision: "deny",
      resolvedAt: 2_000
    };
    let publishes = 0;
    const store: FakeStore = {
      async getByCallbackHash() { return existing; },
      async resolveByCallbackHash() { return { request: existing, newlyResolved: false }; }
    };
    const response = await handleCallback(
      new Request(`https://nofax.example/r/${token}/allow`, { method: "POST" }),
      envWithStore(store),
      {
        nowImpl: () => 3_000,
        fetchImpl: async () => {
          publishes += 1;
          return new Response("{}", { status: 200 });
        }
      }
    );
    expect(publishes).toBe(0);
    expect(await response.text()).toMatch(/Denied/i);
  });

  it("accepts bounded free-text refinement and rejects blank or oversized text", async () => {
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
    const expectedHash = await hashCallbackToken(token);
    const seen: Array<Record<string, unknown>> = [];
    const store: FakeStore = {
      async getByCallbackHash() { return pending(expectedHash, ["refine"]); },
      async resolveByCallbackHash(input) {
        seen.push(input);
        return {
          request: {
            ...pending(expectedHash, ["refine"]),
            kind: "refinement",
            status: "resolved",
            decision: "refine",
            text: input.text,
            resolvedAt: input.nowMs
          },
          newlyResolved: true
        };
      }
    };
    const env = envWithStore(store);
    const fetchImpl = async () => new Response("{}", { status: 200 });

    const okBody = new URLSearchParams({ text: "  Make it shorter.  " });
    const ok = await handleCallback(
      new Request(`https://nofax.example/r/${token}/refine`, { method: "POST", body: okBody }),
      env,
      { nowImpl: () => 2_000, fetchImpl }
    );
    expect(ok.status).toBe(200);
    expect(seen.at(-1)).toEqual({ callbackHash: expectedHash, decision: "refine", text: "Make it shorter.", nowMs: 2_000 });

    const blank = await handleCallback(
      new Request(`https://nofax.example/r/${token}/refine`, { method: "POST", body: new URLSearchParams({ text: "   " }) }),
      env,
      { nowImpl: () => 2_000, fetchImpl }
    );
    expect(blank.status).toBe(400);

    const oversized = await handleCallback(
      new Request(`https://nofax.example/r/${token}/refine`, { method: "POST", body: new URLSearchParams({ text: "x".repeat(2_001) }) }),
      env,
      { nowImpl: () => 2_000, fetchImpl }
    );
    expect(oversized.status).toBe(400);
  });

  it("fails closed for unknown, expired, malformed, or disallowed callback capabilities", async () => {
    const store: FakeStore = {
      async getByCallbackHash() { return null; },
      async resolveByCallbackHash() { return null; }
    };
    const env = envWithStore(store);
    const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";

    const unknownGet = await handleCallback(new Request(`https://nofax.example/r/${token}`), env, { nowImpl: () => 2_000 });
    expect(unknownGet.status).toBe(404);

    const unknownPost = await handleCallback(new Request(`https://nofax.example/r/${token}/deny`, { method: "POST" }), env, { nowImpl: () => 2_000 });
    expect(unknownPost.status).toBe(404);

    const malformed = await handleCallback(new Request("https://nofax.example/r/x/allow", { method: "POST" }), env, { nowImpl: () => 2_000 });
    expect(malformed.status).toBe(404);
  });
});
