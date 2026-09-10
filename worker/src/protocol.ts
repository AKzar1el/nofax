function randomBase64Url(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createRequestId(): string {
  return `nfx_${randomBase64Url(18)}`;
}

export function createCallbackToken(): string {
  return randomBase64Url(32);
}

export async function hashCallbackToken(token: string): Promise<string> {
  if (typeof token !== "string" || token.length < 1) throw new Error("NOFAX_CALLBACK_TOKEN_REQUIRED");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function boundText(value: unknown, max: number, name: string): string {
  if (!Number.isInteger(max) || max < 1) throw new Error("NOFAX_TEXT_BOUND_INVALID");
  if (typeof value !== "string" || !value.trim()) throw new Error(`NOFAX_${name}_REQUIRED`);
  const text = value.trim();
  if (text.length <= max) return text;
  const marker = "…[truncated]";
  if (max <= marker.length) return text.slice(0, max);
  return `${text.slice(0, max - marker.length)}${marker}`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
