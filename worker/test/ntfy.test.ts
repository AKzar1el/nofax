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
    expect(JSON.parse(String(init?.body))).toEqual({
      topic: "nofax_abcdefghijklmnopqrstuvwxyz123456",
      title: "Build finished",
      message: "Everything passed",
      priority: 4,
      tags: ["bell"]
    });
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
