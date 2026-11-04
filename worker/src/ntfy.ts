import type { Env } from "./env";
import { boundText } from "./protocol";

type FetchLike = typeof fetch;

const MAX_ERROR_BODY_BYTES = 2_048;
const MAX_ERROR_DETAIL_LENGTH = 200;
const MAX_NTFY_MESSAGE_BYTES = 4_096;

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

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

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

function safeDiagnostic(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  // Provider errors are untrusted text. Escape terminal and bidi controls so
  // diagnostic output cannot visually erase or reorder the actual error.
  const text = String(value).replace(/\s+/g, " ").trim().replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
  );
  if (!text) return undefined;
  return text.slice(0, maxLength);
}

async function publishError(response: Response, authenticated = false): Promise<Error> {
  const prefix = `NOFAX_NTFY_PUBLISH_${response.status}`;
  const parts: string[] = [];

  try {
    const body = await readBoundedText(response);
    // An upstream body may echo an authenticated request's headers or token.
    // Drain the bounded response but never expose its text in diagnostics.
    if (body && !authenticated) {
      const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
      const code = safeDiagnostic(parsed.code, 24);
      const detail = safeDiagnostic(parsed.error, MAX_ERROR_DETAIL_LENGTH);
      if (code) parts.push(`code=${code}`);
      const retryAfter = safeDiagnostic(response.headers.get("retry-after"), 64);
      if (retryAfter) parts.push(`retry_after=${retryAfter}`);
      if (detail) parts.push(`detail=${detail}`);
    }
  } catch {
    // Keep provider errors opaque if they are not small, structured ntfy JSON.
  }

  return new Error(parts.length ? `${prefix}: ${parts.join(" ")}` : prefix);
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
  if (topic.length < 24 || topic.length > 64 || !/^[A-Za-z0-9_-]+$/.test(topic) || new Set(topic).size < 8) {
    throw new Error("NOFAX_NTFY_TOPIC_INVALID");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NOFAX_NTFY_PUBLISH_TIMEOUT_INVALID");
  }
  const authorization = publishAuthorization(env);

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
      response = await fetchImpl(serverUrl(env) + "/", {
        method: "POST",
        // Never forward the notification payload to a redirect target.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization })
        },
        signal: controller.signal,
        body: JSON.stringify({
          topic,
          title: boundText(title, 120, "TITLE"),
          message: boundNtfyMessage(message),
          priority: 4,
          tags: ["bell"]
        })
      });
    } catch (error) {
      if (timedOut) throw new Error("NOFAX_NTFY_PUBLISH_TIMEOUT");
      throw new Error(authorization === undefined
        ? "NOFAX_NTFY_PUBLISH_NETWORK: " + (error instanceof Error ? error.message : String(error))
        : "NOFAX_NTFY_PUBLISH_NETWORK");
    }

    if (!response.ok) throw await publishError(response, authorization !== undefined);
  };

  try {
    await Promise.race([publish(), deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
