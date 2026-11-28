import { authorizeMcpRequest } from "./auth";
import type { Env } from "./env";
import { createRemoteMcpHandler } from "./mcp";
import { isTrustedMcpAuthority } from "./request-authority";
export { NofaxRequestStore } from "./request-store";

type McpImpl = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

type RouterOverrides = {
  mcpImpl?: McpImpl;
};

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "www-authenticate": "Bearer"
    }
  });
}

function forbidden(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function defaultMcpImpl(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const handler = createRemoteMcpHandler(env, new URL(request.url).origin);
  return handler.fetch(request);
}

export async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  overrides: RouterOverrides = {}
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : '{"status":"ok"}', {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }

  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    if (!isTrustedMcpAuthority(request, env)) return forbidden();
    const authorization = authorizeMcpRequest(request, env);
    if (!authorization.authorized) {
      return url.pathname === "/mcp" ? unauthorized() : notFound();
    }
    return (overrides.mcpImpl ?? defaultMcpImpl)(authorization.normalizedRequest, env, ctx);
  }

  return notFound();
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
