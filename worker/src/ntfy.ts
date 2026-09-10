import type { Env } from "./env";
import { boundText } from "./protocol";

type FetchLike = typeof fetch;

function serverUrl(env: Env): string {
  const raw = (env.NTFY_SERVER ?? "https://ntfy.sh").trim();
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NOFAX_NTFY_SERVER_INVALID");
  }
  return url.toString().replace(/\/+$/, "");
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

  if (!response.ok) throw new Error(`NOFAX_NTFY_PUBLISH_${response.status}`);
}
