import type { Env } from "./env";
import type { StoredRequest } from "./request-store";

type StoreLike = {
  getRequest(requestId: string): Promise<StoredRequest | null>;
  listPending(limit?: number, nowMs?: number): Promise<StoredRequest[]>;
};

type Overrides = {
  storeImpl?: StoreLike;
  nowImpl?: () => number;
};

function defaultStore(env: Env): StoreLike {
  return env.REQUESTS.getByName("default") as unknown as StoreLike;
}

function publicRequest(request: StoredRequest) {
  const result: Record<string, unknown> = {
    requestId: request.requestId,
    kind: request.kind,
    status: request.status,
    createdAt: new Date(request.createdAt).toISOString()
  };
  if (request.status === "resolved") {
    if (request.resolvedAt !== undefined) result.resolvedAt = new Date(request.resolvedAt).toISOString();
    result.decision = request.decision;
    if (request.text !== undefined) result.text = request.text;
  }
  return result;
}

function validateLimit(value: unknown): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new Error("NOFAX_REQUEST_LIMIT_INVALID");
  }
  return Number(limit);
}

export function createRemoteToolHandlers(env: Env, _origin: string, overrides: Overrides = {}) {
  const deps = {
    store: overrides.storeImpl ?? defaultStore(env),
    now: overrides.nowImpl ?? Date.now
  };

  return {
    async getRequest({ requestId }: { requestId: string }) {
      const current = await deps.store.getRequest(requestId);
      if (current === null) throw new Error("NOFAX_REQUEST_NOT_FOUND");
      return { status: "ok" as const, request: publicRequest(current) };
    },

    async listPending({ limit = 20 }: { limit?: number } = {}) {
      const safeLimit = validateLimit(limit);
      const requests = await deps.store.listPending(safeLimit, deps.now());
      return { status: "ok" as const, requests: requests.map(publicRequest) };
    }
  };
}

export type RemoteToolHandlers = ReturnType<typeof createRemoteToolHandlers>;
