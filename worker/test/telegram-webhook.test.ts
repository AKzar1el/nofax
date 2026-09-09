import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleTelegramWebhook } from "../src/telegram-webhook";
import type { ResolveResult, StoredRequest } from "../src/request-store";

const token = "callback_token_abcdefghijklmnopqrstuvwxyz123456";
const callbackHash = "a".repeat(64);

function env(): Env {
  return {
    REQUESTS: {} as DurableObjectNamespace,
    NOFAX_REMOTE_KEY: "remote-key",
    TELEGRAM_BOT_TOKEN: "123456:TEST_BOT_TOKEN",
    TELEGRAM_CHAT_ID: "456789",
    TELEGRAM_USER_ID: "123456789",
    TELEGRAM_WEBHOOK_SECRET: "telegram_webhook_secret_abcdefghijklmnopqrstuvwxyz"
  };
}

function stored(overrides: Partial<StoredRequest> = {}): StoredRequest {
  return {
    requestId: "nfx_abcdefghijklmnopqrstuvwx",
    kind: "approval",
    status: "pending",
    title: "Deploy?",
    message: "Release ready",
    allowed: ["allow", "deny"],
    callbackHash,
    createdAt: 1_000,
    expiresAt: 100_000,
    ...overrides
  };
}

function update({
  data = `nfx:${token}:allow`,
  userId = 123456789,
  chatId = 456789,
  callbackQueryId = "cq1"
}: {
  data?: string;
  userId?: number;
  chatId?: number;
  callbackQueryId?: string;
} = {}) {
  return {
    update_id: 77,
    callback_query: {
      id: callbackQueryId,
      from: { id: userId },
      message: {
        message_id: 99,
        chat: { id: chatId },
        text: "Deploy?\n\nRelease ready"
      },
      data
    }
  };
}

function request(body: unknown, secret = env().TELEGRAM_WEBHOOK_SECRET): Request {
  return new Request("https://nofax.example/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret })
    },
    body: JSON.stringify(body)
  });
}

describe("Telegram webhook", () => {
  it("rejects a missing or wrong webhook secret before touching durable state", async () => {
    let calls = 0;
    const store = {
      async getByCallbackHash() { calls += 1; return null; },
      async resolveByCallbackHash() { calls += 1; return null; }
    };

    const missing = await handleTelegramWebhook(request(update(), undefined), env(), { storeImpl: store });
    expect(missing.status).toBe(401);
    const wrong = await handleTelegramWebhook(request(update(), "wrong-secret"), env(), { storeImpl: store });
    expect(wrong.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("rejects callbacks from any other Telegram user or chat", async () => {
    let calls = 0;
    const store = {
      async getByCallbackHash() { calls += 1; return null; },
      async resolveByCallbackHash() { calls += 1; return null; }
    };

    expect((await handleTelegramWebhook(request(update({ userId: 7 })), env(), { storeImpl: store })).status).toBe(403);
    expect((await handleTelegramWebhook(request(update({ chatId: 8 })), env(), { storeImpl: store })).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("durably resolves Allow and gives best-effort Telegram feedback", async () => {
    const current = stored();
    let resolveInput: Record<string, unknown> | undefined;
    const calls: Array<{ url: string; body: any }> = [];
    const resolved = stored({ status: "resolved", decision: "allow", resolvedAt: 2_000 });
    const store = {
      async getByCallbackHash(hash: string) {
        expect(hash).toBe(callbackHash);
        return current;
      },
      async resolveByCallbackHash(input: Record<string, unknown>): Promise<ResolveResult> {
        resolveInput = input;
        return { request: resolved, newlyResolved: true };
      }
    };

    const response = await handleTelegramWebhook(request(update()), env(), {
      storeImpl: store,
      hashCallbackTokenImpl: async (value: string) => {
        expect(value).toBe(token);
        return callbackHash;
      },
      nowImpl: () => 2_000,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
    });

    expect(response.status).toBe(200);
    expect(resolveInput).toEqual({ callbackHash, decision: "allow", nowMs: 2_000 });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.telegram.org/bot123456:TEST_BOT_TOKEN/answerCallbackQuery",
      "https://api.telegram.org/bot123456:TEST_BOT_TOKEN/editMessageText"
    ]);
    expect(calls[0].body).toMatchObject({ callback_query_id: "cq1" });
    expect(String(calls[0].body.text)).toMatch(/Approved/);
    expect(JSON.stringify(calls)).not.toContain("allow_paid_broadcast");
  });

  it("maps a numeric choice index through the durable allowed list", async () => {
    const current = stored({ kind: "choice", allowed: ["alpha", "beta", "gamma"] });
    let decision: string | undefined;
    const store = {
      async getByCallbackHash() { return current; },
      async resolveByCallbackHash(input: { decision: string }): Promise<ResolveResult> {
        decision = input.decision;
        return {
          request: stored({
            kind: "choice",
            status: "resolved",
            allowed: current.allowed,
            decision: input.decision,
            resolvedAt: 2_000
          }),
          newlyResolved: true
        };
      }
    };

    const response = await handleTelegramWebhook(request(update({ data: `nfx:${token}:1` })), env(), {
      storeImpl: store,
      hashCallbackTokenImpl: async () => callbackHash,
      nowImpl: () => 2_000,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    });
    expect(response.status).toBe(200);
    expect(decision).toBe("beta");
  });

  it("preserves the first terminal response on a replay", async () => {
    const resolved = stored({ status: "resolved", decision: "deny", resolvedAt: 1_500 });
    let resolvedCalls = 0;
    const store = {
      async getByCallbackHash() { return resolved; },
      async resolveByCallbackHash(): Promise<ResolveResult> {
        resolvedCalls += 1;
        return { request: resolved, newlyResolved: false };
      }
    };

    const response = await handleTelegramWebhook(request(update({ data: `nfx:${token}:allow` })), env(), {
      storeImpl: store,
      hashCallbackTokenImpl: async () => callbackHash,
      nowImpl: () => 2_000,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    });
    expect(response.status).toBe(200);
    expect(resolvedCalls).toBe(1);
    expect(resolved.decision).toBe("deny");
  });

  it("fails closed on malformed callback data and tolerates Telegram UI feedback failure after durable resolution", async () => {
    let resolves = 0;
    const store = {
      async getByCallbackHash() { return stored(); },
      async resolveByCallbackHash(): Promise<ResolveResult> {
        resolves += 1;
        return {
          request: stored({ status: "resolved", decision: "allow", resolvedAt: 2_000 }),
          newlyResolved: true
        };
      }
    };

    const malformed = await handleTelegramWebhook(request(update({ data: "not-nofax" })), env(), { storeImpl: store });
    expect(malformed.status).toBe(400);
    expect(resolves).toBe(0);

    const valid = await handleTelegramWebhook(request(update()), env(), {
      storeImpl: store,
      hashCallbackTokenImpl: async () => callbackHash,
      nowImpl: () => 2_000,
      fetchImpl: async () => new Response("down", { status: 500 })
    });
    expect(valid.status).toBe(200);
    expect(resolves).toBe(1);
  });
});
