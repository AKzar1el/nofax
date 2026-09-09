import { describe, expect, it } from "vitest";
import { publishConfirmation, publishInteractiveNotification } from "../src/ntfy";
import type { Env } from "../src/env";

function response(status = 200): Response {
  return new Response("{}", { status });
}

function config(): Env {
  return {
    NTFY_TOPIC: "nofax_private_topic",
    NTFY_SERVER: "https://ntfy.sh",
    NOFAX_REMOTE_KEY: "super-secret-remote-key",
    REQUESTS: {} as DurableObjectNamespace
  };
}

describe("remote ntfy publisher", () => {
  it("builds Allow / Refine / Deny callbacks without leaking the MCP key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await publishInteractiveNotification({
      env: config(),
      requestId: "nfx_abcdefghijklmnopqrstuvwx",
      callbackToken: "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      title: "Deploy?",
      message: "Release ready",
      options: [
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" }
      ],
      includeRefine: true,
      origin: "https://nofax.example",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return response();
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/");
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload.topic).toBe("nofax_private_topic");
    expect(payload.actions.map((action: { label: string }) => action.label)).toEqual(["Allow", "Refine", "Deny"]);
    expect(payload.actions[0]).toMatchObject({
      action: "http",
      method: "POST",
      url: "https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456/allow",
      clear: true
    });
    expect(payload.actions[1]).toMatchObject({
      action: "view",
      url: "https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456",
      clear: true
    });
    expect(payload.actions[2].url).toBe("https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456/deny");
    expect(JSON.stringify(payload)).not.toContain("super-secret-remote-key");
    expect(calls[0].url).not.toContain("nofax_private_topic");
  });

  it("supports three explicit choices without refinement", async () => {
    let payload: Record<string, unknown> | undefined;
    await publishInteractiveNotification({
      env: config(),
      requestId: "nfx_abcdefghijklmnopqrstuvwx",
      callbackToken: "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      title: "Pick",
      message: "Choose one",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" }
      ],
      includeRefine: false,
      origin: "https://nofax.example",
      fetchImpl: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return response();
      }
    });
    const actions = payload?.actions as Array<{ url: string; method: string }>;
    expect(actions).toHaveLength(3);
    expect(actions[1].url).toBe("https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456/choice?decision=b");
    expect(actions.every((action) => action.method === "POST")).toBe(true);
  });

  it("fails closed when ntfy rejects a publish", async () => {
    await expect(publishInteractiveNotification({
      env: config(),
      requestId: "nfx_abcdefghijklmnopqrstuvwx",
      callbackToken: "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      title: "Deploy?",
      message: "Release ready",
      options: [{ value: "allow", label: "Allow" }],
      includeRefine: false,
      origin: "https://nofax.example",
      fetchImpl: async () => response(429)
    })).rejects.toThrow(/NOFAX_NTFY_PUBLISH_429/);
  });

  it("publishes low-priority terminal confirmation without exposing request secrets", async () => {
    let payload: Record<string, unknown> | undefined;
    const sent = await publishConfirmation({
      env: config(),
      decision: "allow",
      title: "Deploy?",
      fetchImpl: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return response();
      }
    });
    expect(sent).toBe(true);
    expect(payload).toMatchObject({ topic: "nofax_private_topic", priority: 2 });
    expect(String(payload?.title)).toMatch(/Approved/);
    expect(JSON.stringify(payload)).not.toContain("super-secret-remote-key");
  });
});
