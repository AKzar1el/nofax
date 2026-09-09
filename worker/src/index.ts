import { authorizeMcpRequest } from "./auth";
import { handleCallback } from "./callbacks";
import type { Env } from "./env";
import { createRemoteMcpHandler } from "./mcp";
export { NofaxRequestStore } from "./request-store";

type CallbackImpl = (request: Request, env: Env) => Promise<Response>;
type McpImpl = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

type RouterOverrides = {
  callbackImpl?: CallbackImpl;
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

async function defaultMcpImpl(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const handler = createRemoteMcpHandler(env, new URL(request.url).origin);
  return handler(request, env, ctx);
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

  if (url.pathname.startsWith("/r/")) {
    return (overrides.callbackImpl ?? handleCallback)(request, env);
  }

  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
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
