import type { Env } from "./env";
import { renderRefineForm, renderResultPage } from "./mobile";
import { publishTelegramConfirmation as publishConfirmation } from "./telegram";
import { hashCallbackToken } from "./protocol";
import type { ResolveResult, StoredRequest } from "./request-store";

const TOKEN = /^[A-Za-z0-9_-]{32,160}$/;

type FetchLike = typeof fetch;

type RequestStoreRpc = {
  getByCallbackHash(callbackHash: string, nowMs: number): Promise<StoredRequest | null>;
  resolveByCallbackHash(input: {
    callbackHash: string;
    decision: string;
    text?: string;
    nowMs: number;
  }): Promise<ResolveResult | null>;
};

function store(env: Env): RequestStoreRpc {
  return env.REQUESTS.getByName("default") as unknown as RequestStoreRpc;
}

function unavailable(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function badRequest(message = "Invalid response"): Response {
  return new Response(message, {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function resultTitle(decision: string): string {
  if (decision === "allow") return "Approved";
  if (decision === "deny") return "Denied";
  if (decision === "refine") return "Refinement received";
  return "Choice received";
}

function resultMessage(decision: string): string {
  if (decision === "allow") return "Your approval was recorded. The waiting agent may continue within its existing authority.";
  if (decision === "deny") return "Your denial was recorded. The guarded action remains blocked.";
  if (decision === "refine") return "Your refinement was sent back to the waiting agent.";
  return `Your choice was recorded: ${decision}`;
}

function parseRoute(url: URL): { token: string; action?: string } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "r") return null;
  const token = parts[1];
  if (!TOKEN.test(token)) return null;
  return { token, ...(parts[2] ? { action: parts[2] } : {}) };
}

function canonicalPage(request: StoredRequest): Response {
  const decision = request.decision ?? "response";
  return renderResultPage(resultTitle(decision), resultMessage(decision));
}

export async function handleCallback(
  request: Request,
  env: Env,
  overrides: { nowImpl?: () => number; fetchImpl?: FetchLike } = {}
): Promise<Response> {
  const url = new URL(request.url);
  const route = parseRoute(url);
  if (route === null) return unavailable();
  const nowMs = (overrides.nowImpl ?? Date.now)();
  const callbackHash = await hashCallbackToken(route.token);
  const requestStore = store(env);

  if (request.method === "GET" && route.action === undefined) {
    const current = await requestStore.getByCallbackHash(callbackHash, nowMs);
    if (current === null) return unavailable();
    if (current.status === "resolved") return canonicalPage(current);
    if (!current.allowed.includes("refine")) return unavailable();
    return renderRefineForm({ token: route.token, title: current.title, message: current.message });
  }

  if (request.method !== "POST" || route.action === undefined) return unavailable();

  let decision: string;
  let text: string | undefined;
  if (route.action === "allow" || route.action === "deny") {
    decision = route.action;
  } else if (route.action === "choice") {
    const selected = url.searchParams.get("decision")?.trim();
    if (!selected || selected.length > 80) return badRequest();
    decision = selected;
  } else if (route.action === "refine") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return badRequest();
    }
    const raw = form.get("text");
    if (typeof raw !== "string") return badRequest();
    text = raw.trim();
    if (!text || text.length > 2000) return badRequest();
    decision = "refine";
  } else {
    return unavailable();
  }

  let result: ResolveResult | null;
  try {
    result = await requestStore.resolveByCallbackHash({
      callbackHash,
      decision,
      ...(text === undefined ? {} : { text }),
      nowMs
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (/NOFAX_REQUEST_(DECISION|TEXT)_INVALID/.test(code)) return badRequest();
    throw error;
  }
  if (result === null) return unavailable();

  if (result.newlyResolved) {
    await publishConfirmation({
      env,
      decision: result.request.decision ?? decision,
      title: result.request.title,
      fetchImpl: overrides.fetchImpl ?? fetch
    });
  }
  return canonicalPage(result.request);
}
