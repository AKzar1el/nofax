import type { Env } from "./env";

const DNS_HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const AUTHORITY = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i;
const HTTP_ORIGIN = /^(https?):\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i;

/**
 * The MCP SDK's bare fetch adapter does not enforce DNS-rebinding guards.
 * Pin both the request URL and optional client-supplied authorities to a
 * separately configured hostname; never learn the allowlist from the request.
 */
export function isTrustedMcpAuthority(request: Request, env: Env): boolean {
  const hostname = env.NOFAX_MCP_HOSTNAME?.trim();
  if (!hostname || !DNS_HOSTNAME.test(hostname) || hostname !== hostname.toLowerCase()) return false;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }

  const isLocal = hostname === "localhost" || hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) return false;
  if (url.hostname !== hostname || url.username !== "" || url.password !== "") return false;

  const host = request.headers.get("host");
  if (host !== null) {
    const match = AUTHORITY.exec(host);
    if (!match || match[1].toLowerCase() !== hostname) return false;
    const expectedPort = url.port || (url.protocol === "https:" ? "443" : "80");
    if (match[2] && match[2] !== expectedPort) return false;
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (!HTTP_ORIGIN.test(origin)) return false;
    try {
      if (new URL(origin).origin !== url.origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}
