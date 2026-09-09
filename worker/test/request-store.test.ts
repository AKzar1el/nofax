import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type PendingInput = {
  requestId: string;
  kind: "approval" | "choice" | "refinement";
  title: string;
  message: string;
  allowed: string[];
  callbackHash: string;
  createdAt: number;
  expiresAt: number;
};

type StoredRequest = PendingInput & {
  status: "pending" | "resolved";
  decision?: string;
  text?: string;
  resolvedAt?: number;
};

type ResolveResult = { request: StoredRequest; newlyResolved: boolean } | null;

type RequestStoreStub = {
  createRequest(input: PendingInput): Promise<StoredRequest>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  getByCallbackHash(callbackHash: string, nowMs: number): Promise<StoredRequest | null>;
  resolveByCallbackHash(input: {
    callbackHash: string;
    decision: string;
    text?: string;
    nowMs: number;
  }): Promise<ResolveResult>;
  deleteRequest(requestId: string): Promise<boolean>;
  listPending(limit?: number, nowMs?: number): Promise<StoredRequest[]>;
  cleanup(nowMs: number): Promise<number>;
};

function store(name: string): RequestStoreStub {
  return env.REQUESTS.getByName(name) as unknown as RequestStoreStub;
}

function pending(overrides: Partial<PendingInput> = {}): PendingInput {
  return {
    requestId: "nfx_abcdefghijklmnopqrstuvwx",
    kind: "approval",
    title: "Deploy?",
    message: "Release 1.0.0",
    allowed: ["allow", "deny"],
    callbackHash: "a".repeat(64),
    createdAt: 1_000,
    expiresAt: 86_401_000,
    ...overrides
  };
}

describe("NofaxRequestStore", () => {
  it("persists and retrieves a pending request", async () => {
    const stub = store("create-get");
    const created = await stub.createRequest(pending());
    expect(created.status).toBe("pending");
    expect(await stub.getRequest(created.requestId)).toEqual(created);
    expect(await stub.getByCallbackHash(created.callbackHash, 2_000)).toEqual(created);
  });

  it("enforces first terminal response wins", async () => {
    const stub = store("first-wins");
    const input = pending();
    await stub.createRequest(input);

    const first = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "allow",
      nowMs: 2_000
    });
    expect(first?.newlyResolved).toBe(true);
    expect(first?.request.decision).toBe("allow");

    const second = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "deny",
      nowMs: 3_000
    });
    expect(second?.newlyResolved).toBe(false);
    expect(second?.request.decision).toBe("allow");
  });

  it("rejects decisions outside the request allow-list", async () => {
    const stub = store("allowed");
    const input = pending();
    await stub.createRequest(input);
    await expect(stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      text: "change it",
      nowMs: 2_000
    })).rejects.toThrow(/NOFAX_REQUEST_DECISION_INVALID/);
  });

  it("requires non-empty text for refinement and stores bounded text", async () => {
    const stub = store("refine");
    const input = pending({ kind: "refinement", allowed: ["refine"] });
    await stub.createRequest(input);

    await expect(stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      text: "   ",
      nowMs: 2_000
    })).rejects.toThrow(/NOFAX_REQUEST_TEXT_INVALID/);

    const result = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      text: `  ${"x".repeat(2_100)}  `,
      nowMs: 2_000
    });
    expect(result?.request.text?.length).toBe(2_000);
  });

  it("treats expired or unknown callbacks as unavailable", async () => {
    const stub = store("expired");
    const input = pending({ expiresAt: 2_000 });
    await stub.createRequest(input);
    expect(await stub.getByCallbackHash(input.callbackHash, 2_001)).toBeNull();
    expect(await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "allow",
      nowMs: 2_001
    })).toBeNull();
    expect(await stub.getByCallbackHash("b".repeat(64), 1_500)).toBeNull();
  });

  it("lists only live pending requests and can delete orphaned requests", async () => {
    const stub = store("list-delete");
    await stub.createRequest(pending({ requestId: "nfx_aaaaaaaaaaaaaaaaaaaaaaaa", callbackHash: "a".repeat(64) }));
    await stub.createRequest(pending({ requestId: "nfx_bbbbbbbbbbbbbbbbbbbbbbbb", callbackHash: "b".repeat(64), expiresAt: 1_500 }));

    const list = await stub.listPending(10, 2_000);
    expect(list.map((request) => request.requestId)).toEqual(["nfx_aaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(await stub.deleteRequest("nfx_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(await stub.getRequest("nfx_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
});
