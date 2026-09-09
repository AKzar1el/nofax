import type { Env } from "./env";
import {
  publishInteractiveNotification,
  publishNotification,
  type NotificationOption
} from "./ntfy";
import {
  boundText,
  createCallbackToken,
  createRequestId,
  hashCallbackToken
} from "./protocol";
import type { PendingRequestInput, StoredRequest } from "./request-store";

const MAX_WAIT_SECONDS = 20;
const DEFAULT_WAIT_SECONDS = 20;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export const WAIT_REQUIRED = (requestId: string): string =>
  `WAIT REQUIRED: human response for ${requestId} is still pending. Do not continue, infer approval, or complete the guarded action. Call nofax_wait_for_response with requestId "${requestId}" and repeat whenever it returns pending until a terminal response is returned.`;

type StoreLike = {
  createRequest(input: PendingRequestInput): Promise<StoredRequest>;
  deleteRequest(requestId: string): Promise<boolean>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  listPending(limit?: number, nowMs?: number): Promise<StoredRequest[]>;
};

type SleepLike = (milliseconds: number) => Promise<void>;

type Overrides = {
  storeImpl?: StoreLike;
  createRequestIdImpl?: () => string;
  createCallbackTokenImpl?: () => string;
  hashCallbackTokenImpl?: (token: string) => Promise<string>;
  publishInteractiveNotificationImpl?: typeof publishInteractiveNotification;
  publishNotificationImpl?: typeof publishNotification;
  nowImpl?: () => number;
  sleepImpl?: SleepLike;
};

function defaultStore(env: Env): StoreLike {
  return env.REQUESTS.getByName("default") as unknown as StoreLike;
}

function pendingResult(requestId: string) {
  return {
    status: "pending" as const,
    requestId,
    mustWait: true,
    instruction: WAIT_REQUIRED(requestId)
  };
}

function terminalResult(request: StoredRequest) {
  if (request.decision === "allow") {
    return {
      status: "resolved" as const,
      requestId: request.requestId,
      decision: "allow" as const,
      instruction: "Human approved this request. The caller may continue only within its existing authority."
    };
  }
  if (request.decision === "deny") {
    return {
      status: "resolved" as const,
      requestId: request.requestId,
      decision: "deny" as const,
      instruction: "Human denied this request. Do not perform the guarded action."
    };
  }
  if (request.decision === "refine") {
    return {
      status: "resolved" as const,
      requestId: request.requestId,
      decision: "refine" as const,
      text: request.text,
      instruction: "Apply the human refinement. If the resulting action still requires approval, create a new approval request and wait for that new terminal response before acting."
    };
  }
  return {
    status: "resolved" as const,
    requestId: request.requestId,
    decision: request.decision,
    instruction: "Human choice received. Apply only that explicit choice within the caller's existing authority."
  };
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

function validateWaitSeconds(value: unknown): number {
  const seconds = value ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isInteger(seconds) || Number(seconds) < 1 || Number(seconds) > MAX_WAIT_SECONDS) {
    throw new Error("NOFAX_MCP_WAIT_SECONDS_INVALID");
  }
  return Number(seconds);
}

function validateLimit(value: unknown): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new Error("NOFAX_REQUEST_LIMIT_INVALID");
  }
  return Number(limit);
}

function validateChoiceOptions(options: unknown): NotificationOption[] {
  if (!Array.isArray(options) || options.length < 1 || options.length > 3) throw new Error("NOFAX_CHOICE_LIMIT");
  const normalized = options.map((option): NotificationOption => {
    if (typeof option === "string") {
      const value = option.trim();
      if (!value) throw new Error("NOFAX_CHOICE_INVALID");
      return { value: value.slice(0, 80), label: value.slice(0, 32) };
    }
    if (!option || typeof option !== "object") throw new Error("NOFAX_CHOICE_INVALID");
    const record = option as Record<string, unknown>;
    if (typeof record.value !== "string" || typeof record.label !== "string") throw new Error("NOFAX_CHOICE_INVALID");
    const value = record.value.trim();
    const label = record.label.trim();
    if (!value || !label) throw new Error("NOFAX_CHOICE_INVALID");
    return { value: value.slice(0, 80), label: label.slice(0, 32) };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) throw new Error("NOFAX_CHOICE_DUPLICATE");
  return normalized;
}

export function createRemoteToolHandlers(env: Env, origin: string, overrides: Overrides = {}) {
  const deps = {
    store: overrides.storeImpl ?? defaultStore(env),
    createRequestId: overrides.createRequestIdImpl ?? createRequestId,
    createCallbackToken: overrides.createCallbackTokenImpl ?? createCallbackToken,
    hashCallbackToken: overrides.hashCallbackTokenImpl ?? hashCallbackToken,
    publishInteractiveNotification: overrides.publishInteractiveNotificationImpl ?? publishInteractiveNotification,
    publishNotification: overrides.publishNotificationImpl ?? publishNotification,
    now: overrides.nowImpl ?? Date.now,
    sleep: overrides.sleepImpl ?? ((milliseconds: number) => scheduler.wait(milliseconds))
  };

  async function createInteraction({
    kind,
    title,
    message,
    options,
    includeRefine
  }: {
    kind: "approval" | "choice" | "refinement";
    title: string;
    message: string;
    options: NotificationOption[];
    includeRefine: boolean;
  }) {
    const safeTitle = boundText(title, 120, "TITLE");
    const safeMessage = boundText(message, 2200, "MESSAGE");
    const requestId = deps.createRequestId();
    const callbackToken = deps.createCallbackToken();
    const callbackHash = await deps.hashCallbackToken(callbackToken);
    const createdAt = deps.now();
    const allowed = includeRefine && options.length === 2
      ? [options[0].value, "refine", options[1].value]
      : [...options.map((option) => option.value), ...(includeRefine ? ["refine"] : [])];

    const storedInput: PendingRequestInput = {
      requestId,
      kind,
      title: safeTitle,
      message: safeMessage,
      allowed,
      callbackHash,
      createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS
    };

    await deps.store.createRequest(storedInput);
    try {
      await deps.publishInteractiveNotification({
        env,
        requestId,
        callbackToken,
        title: safeTitle,
        message: safeMessage,
        options,
        includeRefine,
        origin
      });
    } catch (error) {
      try {
        await deps.store.deleteRequest(requestId);
      } catch {
        // Preserve the delivery failure as the primary error. The request is still
        // unusable without the discarded callback token even if cleanup also fails.
      }
      throw error;
    }
    return pendingResult(requestId);
  }

  return {
    async notify({ title = "Nofax", message }: { title?: string; message: string }) {
      const safeTitle = boundText(title, 120, "TITLE");
      const safeMessage = boundText(message, 2200, "MESSAGE");
      await deps.publishNotification({ env, title: safeTitle, message: safeMessage });
      return { status: "sent" as const };
    },

    async requestApproval({
      title = "Nofax approval",
      message,
      allowRefine = false
    }: {
      title?: string;
      message: string;
      allowRefine?: boolean;
    }) {
      return createInteraction({
        kind: "approval",
        title,
        message,
        options: [
          { value: "allow", label: "Allow" },
          { value: "deny", label: "Deny" }
        ],
        includeRefine: allowRefine === true
      });
    },

    async requestChoice({
      title = "Nofax choice",
      message,
      options
    }: {
      title?: string;
      message: string;
      options: unknown;
    }) {
      return createInteraction({
        kind: "choice",
        title,
        message,
        options: validateChoiceOptions(options),
        includeRefine: false
      });
    },

    async requestRefinement({
      title = "Nofax refinement",
      message
    }: {
      title?: string;
      message: string;
    }) {
      return createInteraction({
        kind: "refinement",
        title,
        message,
        options: [],
        includeRefine: true
      });
    },

    async waitForResponse({ requestId, waitSeconds }: { requestId: string; waitSeconds?: number }) {
      const seconds = validateWaitSeconds(waitSeconds);
      let current = await deps.store.getRequest(requestId);
      if (current === null) throw new Error("NOFAX_REQUEST_NOT_FOUND");
      if (current.status === "resolved") return terminalResult(current);

      const deadline = deps.now() + seconds * 1000;
      while (deps.now() < deadline) {
        const remaining = deadline - deps.now();
        if (remaining <= 0) break;
        await deps.sleep(Math.min(1000, remaining));
        current = await deps.store.getRequest(requestId);
        if (current === null) throw new Error("NOFAX_REQUEST_NOT_FOUND");
        if (current.status === "resolved") return terminalResult(current);
      }
      return pendingResult(requestId);
    },

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
