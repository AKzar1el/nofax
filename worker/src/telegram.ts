import type { Env } from "./env";
import { boundText } from "./protocol";

export interface TelegramNotificationOption {
  value: string;
  label: string;
}

type FetchLike = typeof fetch;

const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{32,52}$/;

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function botToken(env: Env): string {
  return required(env.TELEGRAM_BOT_TOKEN, "NOFAX_TELEGRAM_BOT_TOKEN_REQUIRED");
}

function chatId(env: Env): string {
  return required(env.TELEGRAM_CHAT_ID, "NOFAX_TELEGRAM_CHAT_ID_REQUIRED");
}

function apiUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${botToken(env)}/${method}`;
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("NOFAX_ORIGIN_INVALID");
  return url.origin;
}

function normalizeOptions(options: TelegramNotificationOption[]): TelegramNotificationOption[] {
  if (!Array.isArray(options) || options.length > 3) throw new Error("NOFAX_CHOICE_LIMIT");
  const normalized = options.map((option) => {
    if (!option || typeof option.value !== "string" || typeof option.label !== "string") {
      throw new Error("NOFAX_CHOICE_INVALID");
    }
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label || value.length > 80 || label.length > 32) throw new Error("NOFAX_CHOICE_INVALID");
    return { value, label };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) {
    throw new Error("NOFAX_CHOICE_DUPLICATE");
  }
  return normalized;
}

async function telegramCall({
  env,
  method,
  payload,
  fetchImpl,
  errorPrefix
}: {
  env: Env;
  method: string;
  payload: Record<string, unknown>;
  fetchImpl: FetchLike;
  errorPrefix: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(apiUrl(env, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error(`${errorPrefix}_NETWORK`);
  }

  if (!response.ok) throw new Error(`${errorPrefix}_${response.status}`);

  try {
    const body = await response.json() as { ok?: boolean; result?: unknown };
    if (body.ok === false) throw new Error(`${errorPrefix}_REJECTED`);
    return body.result;
  } catch (error) {
    if (error instanceof Error && error.message === `${errorPrefix}_REJECTED`) throw error;
    return undefined;
  }
}

function messageText(title: string, message: string): string {
  return `${boundText(title, 120, "TITLE")}\n\n${boundText(message, 2200, "MESSAGE")}`;
}

function callbackData(callbackToken: string, option: TelegramNotificationOption, index: number): string {
  const action = option.value === "allow" || option.value === "deny" ? option.value : String(index);
  const value = `nfx:${callbackToken}:${action}`;
  if (new TextEncoder().encode(value).byteLength > 64) throw new Error("NOFAX_TELEGRAM_CALLBACK_DATA_TOO_LONG");
  return value;
}

export async function publishTelegramNotification({
  env,
  title,
  message,
  fetchImpl = fetch
}: {
  env: Env;
  title: string;
  message: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  await telegramCall({
    env,
    method: "sendMessage",
    payload: {
      chat_id: chatId(env),
      text: messageText(title, message)
    },
    fetchImpl,
    errorPrefix: "NOFAX_TELEGRAM_PUBLISH"
  });
}

export async function publishTelegramInteractive({
  env,
  callbackToken,
  title,
  message,
  options,
  includeRefine,
  origin,
  fetchImpl = fetch
}: {
  env: Env;
  requestId: string;
  callbackToken: string;
  title: string;
  message: string;
  options: TelegramNotificationOption[];
  includeRefine: boolean;
  origin: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  if (typeof callbackToken !== "string" || !CALLBACK_TOKEN.test(callbackToken)) {
    throw new Error("NOFAX_CALLBACK_TOKEN_INVALID");
  }
  const normalized = normalizeOptions(options);
  const total = normalized.length + (includeRefine ? 1 : 0);
  if (total < 1 || total > 3) throw new Error("NOFAX_CHOICE_LIMIT");

  const safeOrigin = normalizeOrigin(origin);
  const buttons: Array<Record<string, string>> = [];
  const addOption = (option: TelegramNotificationOption, index: number) => {
    buttons.push({
      text: option.label,
      callback_data: callbackData(callbackToken, option, index)
    });
  };
  const addRefine = () => {
    buttons.push({
      text: "Refine",
      url: `${safeOrigin}/r/${encodeURIComponent(callbackToken)}`
    });
  };

  if (includeRefine && normalized.length === 2) {
    addOption(normalized[0], 0);
    addRefine();
    addOption(normalized[1], 1);
  } else {
    normalized.forEach(addOption);
    if (includeRefine) addRefine();
  }

  await telegramCall({
    env,
    method: "sendMessage",
    payload: {
      chat_id: chatId(env),
      text: messageText(title, message),
      reply_markup: { inline_keyboard: [buttons] }
    },
    fetchImpl,
    errorPrefix: "NOFAX_TELEGRAM_PUBLISH"
  });
}

export async function publishTelegramConfirmation({
  env,
  decision,
  title,
  fetchImpl = fetch
}: {
  env: Env;
  decision: string;
  title: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  let prefix = "✅ Choice received";
  if (decision === "allow") prefix = "✅ Approved";
  else if (decision === "deny") prefix = "⛔ Denied";
  else if (decision === "refine") prefix = "✏️ Refinement received";

  try {
    await telegramCall({
      env,
      method: "sendMessage",
      payload: {
        chat_id: chatId(env),
        text: `${prefix}\n\n${boundText(title, 120, "TITLE")}`
      },
      fetchImpl,
      errorPrefix: "NOFAX_TELEGRAM_CONFIRM"
    });
    return true;
  } catch {
    return false;
  }
}

export async function answerTelegramCallback({
  env,
  callbackQueryId,
  text,
  fetchImpl = fetch
}: {
  env: Env;
  callbackQueryId: string;
  text: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  try {
    await telegramCall({
      env,
      method: "answerCallbackQuery",
      payload: {
        callback_query_id: callbackQueryId,
        text: boundText(text, 180, "MESSAGE")
      },
      fetchImpl,
      errorPrefix: "NOFAX_TELEGRAM_CALLBACK_ACK"
    });
    return true;
  } catch {
    return false;
  }
}

export async function editTelegramTerminalMessage({
  env,
  chatId: targetChatId,
  messageId,
  originalText,
  statusText,
  fetchImpl = fetch
}: {
  env: Env;
  chatId: string;
  messageId: number;
  originalText: string;
  statusText: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  try {
    await telegramCall({
      env,
      method: "editMessageText",
      payload: {
        chat_id: targetChatId,
        message_id: messageId,
        text: `${boundText(originalText, 3600, "MESSAGE")}\n\n${boundText(statusText, 240, "MESSAGE")}`
      },
      fetchImpl,
      errorPrefix: "NOFAX_TELEGRAM_EDIT"
    });
    return true;
  } catch {
    return false;
  }
}
