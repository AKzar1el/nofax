import type { Env } from "./env";
import { boundText } from "./protocol";

type FetchLike = typeof fetch;

const MAX_ERROR_BODY_BYTES = 2_048;
const MAX_NTFY_MESSAGE_BYTES = 4_096;
const MAX_TIMEOUT_MS = 2_147_483_647;

function hasRepeatedTopicPattern(topic: string): boolean {
  // Even eight distinct characters can form a short, guessable repeating topic.
  for (let length = 1; length <= Math.floor(topic.length / 2); length += 1) {
    if (topic.length % length === 0 && topic === topic.slice(0, length).repeat(topic.length / length)) {
      return true;
    }
  }
  return false;
}

function visibleNotificationText(value: string): string {
  // MCP callers can supply terminal controls or Unicode direction overrides.
  // Preserve emoji ZWJ sequences, but expose hidden joiners inside words.
  const characters = [...value];
  return characters.map((character, index) => {
    if (character === "\u200c" || character === "\u200d") {
      let before = index - 1;
      while (before >= 0 && /[\ufe0e\ufe0f\p{Emoji_Modifier}]/u.test(characters[before])) before--;
      if (character === "\u200d" &&
          /\p{Extended_Pictographic}/u.test(characters[before] ?? "") &&
          /\p{Extended_Pictographic}/u.test(characters[index + 1] ?? "")) {
        return character;
      }
      return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    }
    return character.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u180e\u200b\u200e-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu,
      (control) => `\\u${control.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  }).join("");
}

function visibleNotificationTitle(value: string): string {
  // Titles must remain single-line so untrusted text cannot impersonate body content.
  return visibleNotificationText(value).replace(/\n/g, "\\u000a");
}

function boundNtfyMessage(value: string): string {
  const text = boundText(value, 2200, "MESSAGE");
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= MAX_NTFY_MESSAGE_BYTES) return text;

  const marker = "…[truncated]";
  const maxContentBytes = MAX_NTFY_MESSAGE_BYTES - encoder.encode(marker).byteLength;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxContentBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("") + marker;
}

function serverUrl(env: Env): string {
  const raw = env.NTFY_SERVER ?? "https://ntfy.sh";
  let url: URL;
  try {
    if (typeof raw !== "string") throw new Error("invalid server");
    url = new URL(raw.trim());
  } catch {
    throw new Error("NOFAX_NTFY_SERVER_INVALID");
  }
  // Remote Worker notifications must not leak topic capabilities over cleartext
  // or publish to an embedded path, query, fragment, or credential-bearing URL.
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("NOFAX_NTFY_SERVER_INVALID");
  }
  return url.origin;
}

function publishAuthorization(env: Env): string | undefined {
  const token = env.NOFAX_NTFY_TOKEN;
  if (token === undefined) return undefined;
  // The token is an optional Worker secret, never an MCP credential or URL component.
  if (typeof token !== "string" || token.length < 8 || token.length > 1024 ||
      !/^[A-Za-z0-9_./+~=-]+$/.test(token)) {
    throw new Error("NOFAX_NTFY_AUTH_TOKEN_INVALID");
  }
  return `Bearer ${token}`;
}

async function readBoundedText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    try {
      // A fetch shim can ignore abort after returning response headers. The
      // deadline must still release its pending error-body reader.
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // Disposal errors must not override the publication timeout.
    }
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  if (signal?.aborted) cancelOnAbort();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return "";
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function publishError(response: Response, authenticated = false, signal?: AbortSignal): Promise<Error> {
  const prefix = `NOFAX_NTFY_PUBLISH_${response.status}`;
  const parts: string[] = [];

  // An ntfy topic is itself an access capability. Even without a bearer token,
  // upstream errors, headers and transport exceptions can echo it or the payload.
  // Expose only strictly validated numeric diagnostics, never provider prose.
  if (!authenticated) {
    try {
      const body = await readBoundedText(response, signal);
      if (body) {
        const parsed = JSON.parse(body) as { code?: unknown };
        const code = parsed?.code;
        if (typeof code === "number" && Number.isSafeInteger(code) && code >= 100 && code <= 999_999) {
          parts.push(`code=${code}`);
        }
      }
    } catch {
      // Keep malformed or oversized provider bodies opaque.
    }
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d{1,5}$/.test(retryAfter)) {
      const seconds = Number(retryAfter);
      if (seconds <= 86_400) parts.push(`retry_after=${seconds}`);
    }
  }

  return new Error(parts.length ? `${prefix}: ${parts.join(" ")}` : prefix);
}

function releaseResponseBody(response: Response): void {
  // ntfy receipts are never needed after status inspection. Release unread
  // streams without allowing a provider cancellation error to mask the result.
  void response.body?.cancel().catch(() => {});
}

export async function publishNotification({
  env,
  title,
  message,
  fetchImpl = fetch,
  timeoutMs = 15_000
}: {
  env: Env;
  title: string;
  message: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const topic = typeof env.NTFY_TOPIC === "string" ? env.NTFY_TOPIC.trim() : "";
  if (!topic) throw new Error("NOFAX_NTFY_TOPIC_REQUIRED");
  // Topics are bearer-like capabilities: do not publish to short or path-like names.
  if (topic.length < 24 || topic.length > 64 || !/^[A-Za-z0-9_-]+$/.test(topic) ||
      new Set(topic).size < 8 || hasRepeatedTopicPattern(topic)) {
    throw new Error("NOFAX_NTFY_TOPIC_INVALID");
  }
  // Larger timer delays can overflow to an immediate timeout in Node runtimes.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("NOFAX_NTFY_PUBLISH_TIMEOUT_INVALID");
  }
  const authorization = publishAuthorization(env);
  const targetUrl = serverUrl(env) + "/";
  // Reject invalid caller input before entering the transport-error catch.
  // Otherwise a local validation error is mislabeled as a network failure.
  const body = JSON.stringify({
    topic,
    title: boundText(visibleNotificationTitle(title), 120, "TITLE"),
    message: boundNtfyMessage(visibleNotificationText(message)),
    priority: 4,
    tags: ["bell"]
  });

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("NOFAX_NTFY_PUBLISH_TIMEOUT"));
    }, timeoutMs);
  });

  const publish = async () => {
    let response: Response;
    try {
      response = await fetchImpl(targetUrl, {
        method: "POST",
        // Never forward the notification payload to a redirect target.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization })
        },
        signal: controller.signal,
        body
      });
    } catch {
      if (timedOut) throw new Error("NOFAX_NTFY_PUBLISH_TIMEOUT");
      throw new Error("NOFAX_NTFY_PUBLISH_NETWORK");
    }

    if (!response.ok) {
      try {
        throw await publishError(response, authorization !== undefined, controller.signal);
      } finally {
        releaseResponseBody(response);
      }
    }
    releaseResponseBody(response);
  };

  try {
    await Promise.race([publish(), deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
