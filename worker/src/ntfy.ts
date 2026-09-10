import type { Env } from "./env";
import { boundText } from "./protocol";

type FetchLike = typeof fetch;

const MAX_ERROR_BODY_BYTES = 2_048;
const MAX_ERROR_DETAIL_LENGTH = 200;

function serverUrl(env: Env): string {
  const raw = (env.NTFY_SERVER ?? "https://ntfy.sh").trim();
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NOFAX_NTFY_SERVER_INVALID");
  }
  return url.toString().replace(/\/+$/, "");
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
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, maxLength);
}

async function publishError(response: Response): Promise<Error> {
  const prefix = `NOFAX_NTFY_PUBLISH_${response.status}`;
  const parts: string[] = [];

  try {
    const body = await readBoundedText(response);
    if (body) {
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
  fetchImpl = fetch
}: {
  env: Env;
  title: string;
  message: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const topic = env.NTFY_TOPIC?.trim();
  if (!topic) throw new Error("NOFAX_NTFY_TOPIC_REQUIRED");

  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl(env)}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic,
        title: boundText(title, 120, "TITLE"),
        message: boundText(message, 2200, "MESSAGE"),
        priority: 4,
        tags: ["bell"]
      })
    });
  } catch (error) {
    throw new Error(`NOFAX_NTFY_PUBLISH_NETWORK: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) throw await publishError(response);
}
