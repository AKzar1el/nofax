import type { Env } from "./env";
import { boundText } from "./protocol";

export interface NotificationOption {
  value: string;
  label: string;
}

type FetchLike = typeof fetch;

function serverUrl(env: Env): string {
  const raw = (env.NTFY_SERVER ?? "https://ntfy.sh").trim();
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("NOFAX_NTFY_SERVER_INVALID");
  return url.toString().replace(/\/+$/, "");
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("NOFAX_ORIGIN_INVALID");
  return url.origin;
}

function normalizeOptions(options: NotificationOption[]): NotificationOption[] {
  if (!Array.isArray(options) || options.length > 3) throw new Error("NOFAX_CHOICE_LIMIT");
  const normalized = options.map((option) => {
    if (!option || typeof option.value !== "string" || typeof option.label !== "string") throw new Error("NOFAX_CHOICE_INVALID");
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label || value.length > 80 || label.length > 32) throw new Error("NOFAX_CHOICE_INVALID");
    return { value, label };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) throw new Error("NOFAX_CHOICE_DUPLICATE");
  return normalized;
}

function callbackUrl(origin: string, token: string, value: string): string {
  const base = `${origin}/r/${encodeURIComponent(token)}`;
  if (value === "allow" || value === "deny") return `${base}/${value}`;
  return `${base}/choice?decision=${encodeURIComponent(value)}`;
}

async function publish(env: Env, payload: Record<string, unknown>, fetchImpl: FetchLike): Promise<void> {
  if (typeof env.NTFY_TOPIC !== "string" || !env.NTFY_TOPIC.trim()) throw new Error("NOFAX_NTFY_TOPIC_REQUIRED");
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl(env)}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC.trim(), ...payload })
    });
  } catch (error) {
    throw new Error(`NOFAX_NTFY_PUBLISH_NETWORK: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`NOFAX_NTFY_PUBLISH_${response.status}`);
}

export async function publishInteractiveNotification({
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
  options: NotificationOption[];
  includeRefine: boolean;
  origin: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  if (typeof callbackToken !== "string" || !/^[A-Za-z0-9_-]{32,160}$/.test(callbackToken)) {
    throw new Error("NOFAX_CALLBACK_TOKEN_INVALID");
  }
  const normalized = normalizeOptions(options);
  const total = normalized.length + (includeRefine ? 1 : 0);
  if (total < 1 || total > 3) throw new Error("NOFAX_CHOICE_LIMIT");
  const safeOrigin = normalizeOrigin(origin);
  const base = `${safeOrigin}/r/${encodeURIComponent(callbackToken)}`;
  const actions: Array<Record<string, unknown>> = [];

  const addHttp = (option: NotificationOption) => {
    actions.push({
      action: "http",
      label: option.label,
      url: callbackUrl(safeOrigin, callbackToken, option.value),
      method: "POST",
      clear: true
    });
  };
  const addRefine = () => {
    actions.push({ action: "view", label: "Refine", url: base, clear: true });
  };

  if (includeRefine && normalized.length === 2) {
    addHttp(normalized[0]);
    addRefine();
    addHttp(normalized[1]);
  } else {
    for (const option of normalized) addHttp(option);
    if (includeRefine) addRefine();
  }

  await publish(env, {
    title: boundText(title, 120, "TITLE"),
    message: boundText(message, 2200, "MESSAGE"),
    priority: 4,
    tags: ["bell"],
    actions
  }, fetchImpl);
}

export async function publishConfirmation({
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
  let confirmation = "Choice received";
  let message = `Nofax recorded: ${decision}`;
  let tag = "white_check_mark";
  if (decision === "allow") confirmation = "Approved";
  else if (decision === "deny") {
    confirmation = "Denied";
    tag = "no_entry";
  } else if (decision === "refine") {
    confirmation = "Refinement received";
    message = "Your refinement was sent back to the agent.";
  }
  try {
    await publish(env, {
      title: `${confirmation} - ${boundText(title, 100, "TITLE")}`,
      message,
      priority: 2,
      tags: [tag]
    }, fetchImpl);
    return true;
  } catch {
    return false;
  }
}
