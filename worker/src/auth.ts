import type { Env } from "./env";

function configuredKey(env: Env): string | null {
  if (typeof env.NOFAX_REMOTE_KEY !== "string") return null;
  const key = env.NOFAX_REMOTE_KEY.trim();
  return key.length > 0 ? key : null;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

function stripMcpCredential(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/mcp";
  const normalized = new Request(url.toString(), request);
  const headers = new Headers(normalized.headers);
  headers.delete("authorization");
  return new Request(normalized, { headers });
}

function bearerCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function pathCredential(url: URL): string | null {
  if (!url.pathname.startsWith("/mcp/")) return null;
  const encoded = url.pathname.slice("/mcp/".length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function authorizeMcpRequest(
  request: Request,
  env: Env
): { authorized: boolean; normalizedRequest: Request } {
  const expected = configuredKey(env);
  const url = new URL(request.url);
  if (expected === null) return { authorized: false, normalizedRequest: request };

  if (url.pathname === "/mcp") {
    const candidate = bearerCredential(request);
    if (candidate !== null && constantTimeEqual(candidate, expected)) {
      return { authorized: true, normalizedRequest: stripMcpCredential(request) };
    }
    return { authorized: false, normalizedRequest: request };
  }

  const candidate = pathCredential(url);
  if (candidate !== null && constantTimeEqual(candidate, expected)) {
    return { authorized: true, normalizedRequest: stripMcpCredential(request) };
  }
  return { authorized: false, normalizedRequest: request };
}
