import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  editTelegramTerminalMessage,
  publishTelegramInteractive,
  publishTelegramNotification
} from "../src/telegram";

function response(status = 200, body: unknown = { ok: true, result: {} }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function config(): Env {
  return {
    NTFY_TOPIC: "legacy_local_topic",
    TELEGRAM_BOT_TOKEN: "123456:TEST_BOT_TOKEN",
    TELEGRAM_CHAT_ID: "456789",
    TELEGRAM_USER_ID: "123456789",
    TELEGRAM_WEBHOOK_SECRET: "webhook_secret_abcdefghijklmnopqrstuvwxyz",
    NOFAX_REMOTE_KEY: "super-secret-remote-key",
    REQUESTS: {} as DurableObjectNamespace
  } as unknown as Env;
}

describe("Telegram remote publisher", () => {
  it("sends a normal free notification without paid-broadcast fields", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await publishTelegramNotification({
      env: config(),
      title: "Nofax",
      message: "Hello",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return response();
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123456:TEST_BOT_TOKEN/sendMessage");
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload).toMatchObject({ chat_id: "456789", text: "Nofax\n\nHello" });
    expect(JSON.stringify(payload)).not.toContain("allow_paid_broadcast");
    expect(JSON.stringify(payload)).not.toContain("super-secret-remote-key");
  });

  it("builds Allow / Refine / Deny inline buttons with opaque callback capability", async () => {
    let payload: any;
    await publishTelegramInteractive({
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
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        payload = JSON.parse(String(init?.body));
        return response();
      }
    });

    const buttons = payload.reply_markup.inline_keyboard[0];
    expect(buttons.map((button: { text: string }) => button.text)).toEqual(["Allow", "Refine", "Deny"]);
    expect(buttons[0].callback_data).toBe("nfx:callback_token_abcdefghijklmnopqrstuvwxyz123456:allow");
    expect(buttons[1].url).toBe("https://nofax.example/r/callback_token_abcdefghijklmnopqrstuvwxyz123456");
    expect(buttons[2].callback_data).toBe("nfx:callback_token_abcdefghijklmnopqrstuvwxyz123456:deny");
    expect(JSON.stringify(payload)).not.toContain("allow_paid_broadcast");
    expect(JSON.stringify(payload)).not.toContain("super-secret-remote-key");
  });

  it("maps explicit choices into callback data without embedding MCP credentials", async () => {
    let payload: any;
    await publishTelegramInteractive({
      env: config(),
      requestId: "nfx_abcdefghijklmnopqrstuvwx",
      callbackToken: "callback_token_abcdefghijklmnopqrstuvwxyz123456",
      title: "Pick",
      message: "Choose one",
      options: [
        { value: "alpha", label: "A" },
        { value: "beta", label: "B" },
        { value: "gamma", label: "C" }
      ],
      includeRefine: false,
      origin: "https://nofax.example",
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        payload = JSON.parse(String(init?.body));
        return response();
      }
    });

    const buttons = payload.reply_markup.inline_keyboard[0];
    expect(buttons.map((button: { callback_data: string }) => button.callback_data)).toEqual([
      "nfx:callback_token_abcdefghijklmnopqrstuvwxyz123456:0",
      "nfx:callback_token_abcdefghijklmnopqrstuvwxyz123456:1",
      "nfx:callback_token_abcdefghijklmnopqrstuvwxyz123456:2"
    ]);
  });

  it("removes the inline keyboard when editing a terminal Telegram message", async () => {
    let payload: any;
    const edited = await editTelegramTerminalMessage({
      env: config(),
      chatId: "456789",
      messageId: 99,
      originalText: "Deploy?\n\nRelease ready",
      statusText: "✅ Approved",
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        payload = JSON.parse(String(init?.body));
        return response();
      }
    });

    expect(edited).toBe(true);
    expect(payload).toMatchObject({
      chat_id: "456789",
      message_id: 99,
      reply_markup: { inline_keyboard: [] }
    });
  });

  it("fails closed when Telegram rejects a publish", async () => {
    await expect(publishTelegramNotification({
      env: config(),
      title: "Nofax",
      message: "Hello",
      fetchImpl: async () => response(429, { ok: false })
    })).rejects.toThrow(/NOFAX_TELEGRAM_PUBLISH_429/);
  });

  it("requires Telegram bot and chat configuration", async () => {
    const env = config() as any;
    env.TELEGRAM_BOT_TOKEN = "";
    await expect(publishTelegramNotification({
      env,
      title: "Nofax",
      message: "Hello",
      fetchImpl: async () => response()
    })).rejects.toThrow(/NOFAX_TELEGRAM_BOT_TOKEN_REQUIRED/);
  });
});
