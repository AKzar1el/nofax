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

  it("reports invalid local notification text without misclassifying it as a network failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("unexpected");
    }) as typeof fetch;

    await expect(publishNotification({
      env: env(), title: "  ", message: "valid message", fetchImpl
    })).rejects.toThrow(/^NOFAX_TITLE_REQUIRED$/);
    await expect(publishNotification({
      env: env(), title: "valid title", message: "  ", fetchImpl
    })).rejects.toThrow(/^NOFAX_MESSAGE_REQUIRED$/);
    expect(calls).toBe(0);
  });

  it("releases a successful ntfy response body without consuming provider content", async () => {
    let canceled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private provider receipt"));
      },
      cancel() {
        canceled = true;
      }
    }), { status: 200 });
    await publishNotification({
      env: env(),
      title: "Synthetic",
      message: "One-way notification",
      fetchImpl: (async () => response) as typeof fetch
    });
    expect(canceled).toBe(true);
  });

  it("releases authenticated rejection bodies without leaking provider details", async () => {
    let canceled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("secret provider diagnostics"));
      },
      cancel() {
        canceled = true;
      }
    }), { status: 401 });
    await expect(publishNotification({
      env: env({ NOFAX_NTFY_TOKEN: "tk_synthetic_worker_ntfy_token_123456" }),
      title: "Synthetic",
      message: "One-way notification",
      fetchImpl: (async () => response) as typeof fetch
    })).rejects.toThrow("NOFAX_NTFY_PUBLISH_401");
    expect(canceled).toBe(true);
  });

  it("renders untrusted terminal and bidi controls visibly in phone notifications", async () => {
    let payload: { title: string; message: string } | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await publishNotification({
      env: env(),
      title: "Build\u001b[2J\u202E failed",
      message: "Status: pending\rApproved\u0000\u2066\nNext step",
      fetchImpl
    });

    expect(payload?.title).toContain("\\u001b");
    expect(payload?.title).toContain("\\u202e");
    expect(payload?.message).toContain("\\u000d");
    expect(payload?.message).toContain("\\u0000");
    expect(payload?.message).toContain("\\u2066");
    expect(payload?.message).toContain("\nNext step");
    expect(payload?.title).not.toMatch(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/u);
    expect(payload?.message).not.toMatch(/[\x00-\x08\x0b-\x1f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("renders Unicode line and paragraph separators visibly instead of spoofing notification lines", async () => {
    let payload: { title: string; message: string } | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await publishNotification({
      env: env(),
      title: "Pending\u2028Approved",
      message: "Review required\u2029Approved\nStill pending",
      fetchImpl
    });

    expect(payload?.title).toContain("\\u2028");
    expect(payload?.message).toContain("\\u2029");
    expect(payload?.title).not.toContain("\u2028");
    expect(payload?.message).not.toContain("\u2029");
    expect(payload?.message).toContain("\nStill pending");
  });

  it("escapes hidden format marks without breaking emoji joiners or message line breaks", async () => {
    let payload: { title: string; message: string } | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await publishNotification({
      env: env(),
      title: "Pending\u200e\u200f\u061c Approved",
      message: "Review\u200b\u2060\ufeff required\nFamily: 👨‍👩‍👧",
      fetchImpl
    });

    expect(payload?.title).toBe("Pending\\u200e\\u200f\\u061c Approved");
    expect(payload?.message).toBe("Review\\u200b\\u2060\\ufeff required\nFamily: 👨‍👩‍👧");
  });

  it("makes combining grapheme joiners and invisible mathematical operators visible", async () => {
    let payload: { title: string; message: string } | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await publishNotification({
      env: env(),
      title: "Review\u034f\u2061\u2062 required",
      message: "Pending\u2063\u2064 approval\nFamily: 👨‍👩‍👧",
      fetchImpl
    });

    expect(payload?.title).toBe("Review\\u034f\\u2061\\u2062 required");
    expect(payload?.message).toBe("Pending\\u2063\\u2064 approval\nFamily: 👨‍👩‍👧");
  });

  it("bounds notification payloads after expanding unsafe display controls", async () => {
    let payload: { title: string; message: string } | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await publishNotification({
      env: env(),
      title: "\u001b".repeat(120),
      message: "\u202e".repeat(2200),
      fetchImpl
    });

    expect(payload?.title.length).toBeLessThanOrEqual(120);
    expect(payload?.message.length).toBeLessThanOrEqual(2200);
    expect(new TextEncoder().encode(payload?.message).byteLength).toBeLessThanOrEqual(4096);
    expect(payload?.message).toContain("\\u202e");
    expect(payload?.message).not.toContain("\u202e");
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

  it("does not echo the topic capability or notification content in untrusted diagnostics", async () => {
    const topic = "nofax_abcdefghijklmnopqrstuvwxyz123456";
    const title = "Sensitive action requested";
    const message = "Synthetic private approval context";
    const attempt = async (fetchImpl: typeof fetch) => {
      try {
        await publishNotification({ env: env({ NTFY_TOPIC: topic }), title, message, fetchImpl });
        throw new Error("expected a failed publication");
      } catch (error) {
        const diagnostic = (error as Error).message;
        expect(diagnostic).toMatch(/^NOFAX_NTFY_PUBLISH_/);
        for (const secret of [topic, title, message]) expect(diagnostic).not.toContain(secret);
        return diagnostic;
      }
    };

    const providerError = async () => new Response(JSON.stringify({
      code: 42901,
      error: `provider echoed ${topic} and ${title}`
    }), { status: 429, headers: { "retry-after": "12" } });
    expect(await attempt(providerError as typeof fetch))
      .toBe("NOFAX_NTFY_PUBLISH_429: code=42901 retry_after=12");

    const topicAsCode = async () => new Response(JSON.stringify({
      code: topic,
      error: message
    }), { status: 503 });
    expect(await attempt(topicAsCode as typeof fetch)).toBe("NOFAX_NTFY_PUBLISH_503");

    const topicAsRetryAfter = async () => new Response("opaque", {
      status: 429,
      headers: { "retry-after": `12; token=${topic}` }
    });
    expect(await attempt(topicAsRetryAfter as typeof fetch)).toBe("NOFAX_NTFY_PUBLISH_429");

    const transportError = async () => { throw new Error(`transport echoed ${topic} and ${message}`); };
    expect(await attempt(transportError as typeof fetch)).toBe("NOFAX_NTFY_PUBLISH_NETWORK");
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

  it("preserves numeric ntfy rate-limit diagnostics without provider prose", async () => {
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
      "NOFAX_NTFY_PUBLISH_429: code=42901 retry_after=12"
    );
  });

  it("omits untrusted provider display controls from diagnostics", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      code: "429\u001b[0m",
      error: "limit reached\u001b[2K\u202edeny\u0000"
    }), { status: 429, headers: { "retry-after": "12" } })) as typeof fetch;
    let message = "";
    try {
      await publishNotification({ env: env(), title: "Alert", message: "Synthetic only", fetchImpl });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("NOFAX_NTFY_PUBLISH_429");
    expect(message).toBe("NOFAX_NTFY_PUBLISH_429: retry_after=12");
    expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u);
  });
});

describe("bounded remote ntfy publication", () => {
  it("rejects fractional and overflowing timers before any publication", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("ok");
    }) as typeof fetch;

    for (const timeoutMs of [0.5, 12.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      await expect(publishNotification({
        env: env(),
        title: "Alert",
        message: "No dispatch",
        timeoutMs,
        fetchImpl
      })).rejects.toThrow("NOFAX_NTFY_PUBLISH_TIMEOUT_INVALID");
    }
    expect(fetchCalls).toBe(0);
  });

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
