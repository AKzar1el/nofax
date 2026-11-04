import { describe, expect, it } from "vitest";
import { publishNotification } from "../src/ntfy";
import type { Env } from "../src/env";

function env(overrides: Partial<Env> = {}): Env {
  return {
    REQUESTS: {} as DurableObjectNamespace,
    NOFAX_REMOTE_KEY: "remote-key",
    NTFY_TOPIC: "nofax_abcdefghijklmnopqrstuvwxyz123456",
    ...overrides
  };
}

describe("remote ntfy publisher", () => {
  it("publishes one-way notifications to the configured topic", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return new Response("ok", { status: 200 });
    };

    await publishNotification({
      env: env(),
      title: "Build finished",
      message: "Everything passed",
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(url).toBe("https://ntfy.sh/");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      topic: "nofax_abcdefghijklmnopqrstuvwxyz123456",
      title: "Build finished",
      message: "Everything passed",
      priority: 4,
      tags: ["bell"]
    });
  });

  it("adds a configured Worker ntfy bearer token only to the HTTPS publishing request", async () => {
    const secret = "tk_synthetic_worker_ntfy_token_123456";
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return new Response("ok");
    }) as typeof fetch;

    await publishNotification({
      env: env({ NOFAX_NTFY_TOKEN: secret, NTFY_SERVER: "https://ntfy.example" }),
      title: "Synthetic",
      message: "One-way notification",
      fetchImpl
    });
    expect(url).toBe("https://ntfy.example/");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).not.toContain(secret);
  });

  it("rejects invalid configured ntfy bearer tokens before any outbound request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("unexpected");
    }) as typeof fetch;
    for (const secret of ["", "short", "secret with spaces", "bad\nheader", "x".repeat(1025)]) {
      await expect(publishNotification({
        env: env({ NOFAX_NTFY_TOKEN: secret }),
        title: "Synthetic",
        message: "No send",
        fetchImpl
      })).rejects.toThrow("NOFAX_NTFY_AUTH_TOKEN_INVALID");
    }
    expect(calls).toBe(0);
  });

  it("does not echo a bearer secret from a transport error or provider response", async () => {
    const secret = "tk_synthetic_worker_ntfy_token_123456";
    const config = env({ NOFAX_NTFY_TOKEN: secret });
    const attempt = (fetchImpl: typeof fetch) =>
      publishNotification({ env: config, title: "Synthetic", message: "No approval", fetchImpl });
    await expect(attempt((async () => {
      throw new Error(`transport exposed ${secret}`);
    }) as typeof fetch)).rejects.toThrow(/^NOFAX_NTFY_PUBLISH_NETWORK$/);
    await expect(attempt((async () => new Response(JSON.stringify({
      code: 40101,
      error: `invalid token ${secret}`
    }), { status: 401 })) as typeof fetch)).rejects.toThrow(/^NOFAX_NTFY_PUBLISH_401$/);
  });

  it("rejects a redirect rather than forwarding notification contents", async () => {
    let forwarded = false;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("synthetic redirect rejected");
      forwarded = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await expect(publishNotification({
      env: env(),
      title: "Sensitive approval alert",
      message: "Synthetic action context",
      fetchImpl
    })).rejects.toThrow("NOFAX_NTFY_PUBLISH_NETWORK");
    expect(forwarded).toBe(false);
  });

  it("keeps multibyte messages inline within the ntfy 4096-byte limit", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).message as string);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const cjk = "界".repeat(2200);
    const emoji = "🚀".repeat(1100);
    const short = "Ready 🚀";
    for (const message of [cjk, emoji, short]) {
      await publishNotification({ env: env(), title: "Alert", message, fetchImpl });
    }

    const encoder = new TextEncoder();
    expect(sent).toHaveLength(3);
    for (const message of sent) {
      expect(encoder.encode(message).byteLength).toBeLessThanOrEqual(4096);
      expect(message).not.toContain("�");
    }
    expect(sent[0]).toMatch(/^界+…\[truncated\]$/);
    expect(sent[1]).toMatch(/^🚀+…\[truncated\]$/u);
    expect(sent[2]).toBe(short);
  });

  it("fails closed when the remote topic is not configured", async () => {
    const broken = env({ NTFY_TOPIC: "" });
    await expect(publishNotification({
      env: broken,
      title: "Alert",
      message: "Action required",
      fetchImpl: (async () => new Response("unexpected")) as typeof fetch
    })).rejects.toThrow("NOFAX_NTFY_TOPIC_REQUIRED");
  });

  it("rejects unsafe topic configurations before publishing anything", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    }) as typeof fetch;
    const topics = [
      "short",
      "x".repeat(24),
      "x".repeat(65),
      "nofax/abcdefghijklmnopqrstuvwxyz123456",
      "nofax.abcdefghijklmnopqrstuvwxyz123456",
      "nofax_abcdefghijklmnopqrstuvwxyz123456?x=1"
    ];
    for (const topic of topics) {
      await expect(publishNotification({
        env: env({ NTFY_TOPIC: topic }),
        title: "Alert",
        message: "Synthetic",
        fetchImpl
      })).rejects.toThrow("NOFAX_NTFY_TOPIC_INVALID");
    }
    expect(fetchCalls).toBe(0);
  });

  it("rejects insecure or non-origin ntfy server URLs before publishing", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    }) as typeof fetch;
    const servers = [
      "http://ntfy.example",
      "https://user:password@ntfy.example",
      "https://ntfy.example/private/path",
      "https://ntfy.example/?access=private",
      "https://ntfy.example/#fragment",
      "ftp://ntfy.example"
    ];
    for (const server of servers) {
      await expect(publishNotification({
        env: env({ NTFY_SERVER: server }),
        title: "Alert",
        message: "Synthetic only",
        fetchImpl
      })).rejects.toThrow("NOFAX_NTFY_SERVER_INVALID");
    }
    expect(fetchCalls).toBe(0);
  });

  it("normalizes the configured HTTPS ntfy origin", async () => {
    let target = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      target = String(url);
      return new Response("ok");
    }) as typeof fetch;
    await publishNotification({
      env: env({ NTFY_SERVER: "https://ntfy.example:443/" }),
      title: "Alert",
      message: "Synthetic only",
      fetchImpl
    });
    expect(target).toBe("https://ntfy.example/");
  });

  it("preserves bounded ntfy rate-limit diagnostics", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      code: 42901,
      http: 429,
      error: "limit reached: too many requests, please be nice"
    }), {
      status: 429,
      headers: { "retry-after": "12" }
    });

    await expect(publishNotification({
      env: env(),
      title: "Alert",
      message: "Action required",
      fetchImpl: fetchImpl as typeof fetch
    })).rejects.toThrow(
      "NOFAX_NTFY_PUBLISH_429: code=42901 retry_after=12 detail=limit reached: too many requests, please be nice"
    );
  });
});

describe("bounded remote ntfy publication", () => {
  it("times out when fetch ignores abort without claiming delivery", async () => {
    const observed: { signal?: AbortSignal } = {};
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observed.signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const attempt = publishNotification({
      env: env(),
      title: "Alert",
      message: "Requires attention",
      timeoutMs: 25,
      fetchImpl
    });
    await expect(Promise.race([
      attempt,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TEST_UNBOUNDED_FETCH")), 160))
    ])).rejects.toThrow("NOFAX_NTFY_PUBLISH_TIMEOUT");
    expect(observed.signal?.aborted).toBe(true);
  });

  it("bounds reading a nonterminating provider error body", async () => {
    const fetchImpl = (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"partial"'));
        }
      }),
      { status: 503 }
    )) as typeof fetch;
    const attempt = publishNotification({
      env: env(),
      title: "Alert",
      message: "Requires attention",
      timeoutMs: 25,
      fetchImpl
    });
    await expect(Promise.race([
      attempt,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TEST_UNBOUNDED_BODY")), 160))
    ])).rejects.toThrow("NOFAX_NTFY_PUBLISH_TIMEOUT");
  });
});
