import type { Env } from "./env";
import { constantTimeEqual } from "./auth";
import { hashCallbackToken } from "./protocol";
import type { ResolveInput, ResolveResult, StoredRequest } from "./request-store";
import { answerTelegramCallback, editTelegramTerminalMessage } from "./telegram";

type FetchLike = typeof fetch;

type StoreLike = {
  getByCallbackHash(callbackHash: string, nowMs: number): Promise<StoredRequest | null>;
  resolveByCallbackHash(input: ResolveInput): Promise<ResolveResult | null>;
};

type Overrides = {
  storeImpl?: StoreLike;
  hashCallbackTokenImpl?: (token: string) => Promise<string>;
  nowImpl?: () => number;
  fetchImpl?: FetchLike;
};

const CALLBACK_DATA = /^nfx:([A-Za-z0-9_-]{32,52}):(allow|deny|[0-2])$/;

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function defaultStore(env: Env): StoreLike {
  return env.REQUESTS.getByName("default") as unknown as StoreLike;
}

function terminalLabel(request: StoredRequest): string {
  if (request.decision === "allow") return "✅ Approved";
  if (request.decision === "deny") return "⛔ Denied";
  if (request.decision === "refine") return "✏️ Refinement received";
  return `✅ Choice received: ${request.decision ?? "unknown"}`;
}

async function acknowledgeUnavailable({
  env,
  callbackQueryId,
  fetchImpl
}: {
  env: Env;
  callbackQueryId: string;
  fetchImpl: FetchLike;
}) {
  await answerTelegramCallback({
    env,
    callbackQueryId,
    text: "This Nofax request expired or is unavailable.",
    fetchImpl
  });
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  overrides: Overrides = {}
): Promise<Response> {
  if (request.method !== "POST") return json(404, { error: "not_found" });

  const expectedSecret = required(env.TELEGRAM_WEBHOOK_SECRET, "NOFAX_TELEGRAM_WEBHOOK_SECRET_REQUIRED");
  const expectedUserId = required(env.TELEGRAM_USER_ID, "NOFAX_TELEGRAM_USER_ID_REQUIRED");
  const expectedChatId = required(env.TELEGRAM_CHAT_ID, "NOFAX_TELEGRAM_CHAT_ID_REQUIRED");
  const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (providedSecret === null || !constantTimeEqual(providedSecret, expectedSecret)) {
    return json(401, { error: "unauthorized" });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!payload || typeof payload !== "object") return json(400, { error: "invalid_update" });
  const callbackQuery = (payload as Record<string, unknown>).callback_query;
  if (!callbackQuery || typeof callbackQuery !== "object") return json(400, { error: "callback_query_required" });
  const query = callbackQuery as Record<string, unknown>;
  if (typeof query.id !== "string" || !query.id.trim()) return json(400, { error: "callback_query_id_required" });
  const from = query.from;
  const message = query.message;
  if (!from || typeof from !== "object" || !message || typeof message !== "object") {
    return json(400, { error: "callback_context_required" });
  }

  const userId = (from as Record<string, unknown>).id;
  const messageRecord = message as Record<string, unknown>;
  const chat = messageRecord.chat;
  if (!chat || typeof chat !== "object") return json(400, { error: "callback_chat_required" });
  const chatId = (chat as Record<string, unknown>).id;
  if (String(userId) !== expectedUserId || String(chatId) !== expectedChatId) {
    return json(403, { error: "forbidden" });
  }
  if (!Number.isSafeInteger(messageRecord.message_id)) return json(400, { error: "message_id_required" });

  if (typeof query.data !== "string") return json(400, { error: "callback_data_required" });
  const match = CALLBACK_DATA.exec(query.data);
  if (match === null) return json(400, { error: "callback_data_invalid" });

  const deps = {
    store: overrides.storeImpl ?? defaultStore(env),
    hashCallbackToken: overrides.hashCallbackTokenImpl ?? hashCallbackToken,
    now: overrides.nowImpl ?? Date.now,
    fetch: overrides.fetchImpl ?? fetch
  };
  const nowMs = deps.now();
  const callbackHash = await deps.hashCallbackToken(match[1]);
  const current = await deps.store.getByCallbackHash(callbackHash, nowMs);
  if (current === null) {
    await acknowledgeUnavailable({ env, callbackQueryId: query.id, fetchImpl: deps.fetch });
    return json(200, { ok: true });
  }

  let decision: string;
  if (match[2] === "allow" || match[2] === "deny") {
    decision = match[2];
  } else {
    if (current.kind !== "choice") return json(400, { error: "choice_callback_invalid" });
    const index = Number(match[2]);
    decision = current.allowed[index];
    if (typeof decision !== "string") return json(400, { error: "choice_callback_invalid" });
  }

  let result: ResolveResult | null;
  try {
    result = await deps.store.resolveByCallbackHash({ callbackHash, decision, nowMs });
  } catch (error) {
    if (error instanceof Error && error.message === "NOFAX_REQUEST_DECISION_INVALID") {
      return json(400, { error: "decision_invalid" });
    }
    throw error;
  }
  if (result === null) {
    await acknowledgeUnavailable({ env, callbackQueryId: query.id, fetchImpl: deps.fetch });
    return json(200, { ok: true });
  }

  const status = terminalLabel(result.request);
  const ackText = result.newlyResolved ? status : `Already resolved — ${status}`;
  await answerTelegramCallback({
    env,
    callbackQueryId: query.id,
    text: ackText,
    fetchImpl: deps.fetch
  });

  if (typeof messageRecord.text === "string" && messageRecord.text.trim()) {
    await editTelegramTerminalMessage({
      env,
      chatId: expectedChatId,
      messageId: Number(messageRecord.message_id),
      originalText: messageRecord.text,
      statusText: ackText,
      fetchImpl: deps.fetch
    });
  }

  return json(200, { ok: true });
}
