import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env as NofaxEnv } from "../src/env";
import type { NofaxRequestStore } from "../src/request-store";

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

const testEnv = env as unknown as NofaxEnv;

function rawStore(name: string): DurableObjectStub<NofaxRequestStore> {
  return testEnv.REQUESTS.getByName(name) as unknown as DurableObjectStub<NofaxRequestStore>;
}

function store(name: string): RequestStoreStub {
  return rawStore(name) as unknown as RequestStoreStub;
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

  it("rejects unsupported alarm and ISO timestamp ranges before storing requests", async () => {
    const raw = rawStore("invalid-date-range");
    const outsideDateRange = 8_640_000_000_000_001;
    const unsupportedAlarmDate = Date.UTC(2200, 0, 1);

    await runInDurableObject(raw, async (instance: NofaxRequestStore) => {
      await expect(instance.createRequest(pending({
        createdAt: outsideDateRange,
        expiresAt: outsideDateRange + 1_000
      }))).rejects.toThrow("NOFAX_REQUEST_CREATED_AT_INVALID");
      await expect(instance.createRequest(pending({
        expiresAt: outsideDateRange
      }))).rejects.toThrow("NOFAX_REQUEST_EXPIRES_AT_INVALID");
      await expect(instance.createRequest(pending({
        expiresAt: unsupportedAlarmDate
      }))).rejects.toThrow("NOFAX_REQUEST_EXPIRES_AT_INVALID");
      expect(() => instance.getByCallbackHash("a".repeat(64), outsideDateRange))
        .toThrow("NOFAX_NOW_INVALID");
    });
    expect(await store("invalid-date-range").getRequest("nfx_abcdefghijklmnopqrstuvwx")).toBeNull();
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
    const raw = rawStore("allowed");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending();
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance: NofaxRequestStore) => {
      expect(() => instance.resolveByCallbackHash({
        callbackHash: input.callbackHash,
        decision: "refine",
        text: "change it",
        nowMs: 2_000
      })).toThrow(/NOFAX_REQUEST_DECISION_INVALID/);
    });
  });

  it("requires non-empty text for refinement and stores bounded text", async () => {
    const raw = rawStore("refine");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending({ kind: "refinement", allowed: ["refine"] });
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance: NofaxRequestStore) => {
      expect(() => instance.resolveByCallbackHash({
        callbackHash: input.callbackHash,
        decision: "refine",
        text: "   ",
        nowMs: 2_000
      })).toThrow(/NOFAX_REQUEST_TEXT_INVALID/);
    });

    const result = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      text: `  ${"x".repeat(2_100)}  `,
      nowMs: 2_000
    });
    expect(result?.request.text?.length).toBe(2_000);
  });

  it("does not split a Unicode surrogate pair at the refinement text limit", async () => {
    const stub = store("refine-unicode-bound");
    const input = pending({ kind: "refinement", allowed: ["refine"] });
    await stub.createRequest(input);

    const result = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      text: `${"x".repeat(1_999)}\u{1F642} remainder`,
      nowMs: 2_000
    });
    expect(result?.request.text).toBe("x".repeat(1_999));
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

  it("returns the newest live request first when the recovery list is limited", async () => {
    const stub = store("list-newest-first");
    await stub.createRequest(pending({
      requestId: "nfx_oldestaaaaaaaaaaaaaaaaaa", callbackHash: "a".repeat(64), createdAt: 1_000
    }));
    await stub.createRequest(pending({
      requestId: "nfx_newestaaaaaaaaaaaaaaaaaa", callbackHash: "b".repeat(64), createdAt: 1_200
    }));
    await stub.createRequest(pending({
      requestId: "nfx_middleaaaaaaaaaaaaaaaaaa", callbackHash: "c".repeat(64), createdAt: 1_100
    }));

    expect((await stub.listPending(1, 2_000)).map((request) => request.requestId))
      .toEqual(["nfx_newestaaaaaaaaaaaaaaaaaa"]);
    expect((await stub.listPending(3, 2_000)).map((request) => request.requestId))
      .toEqual([
        "nfx_newestaaaaaaaaaaaaaaaaaa",
        "nfx_middleaaaaaaaaaaaaaaaaaa",
        "nfx_oldestaaaaaaaaaaaaaaaaaa"
      ]);
  });

  it("does not purge a still-live approval when a new request has a future timestamp", async () => {
    const stub = store("future-clock-retention");
    const now = Date.now();
    const active = pending({
      requestId: "nfx_activeaaaaaaaaaaaaaaaaaa",
      callbackHash: "c".repeat(64),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000
    });
    await stub.createRequest(active);
    await stub.createRequest(pending({
      requestId: "nfx_futureaaaaaaaaaaaaaaaaaa",
      callbackHash: "d".repeat(64),
      createdAt: now + 2 * 60 * 60 * 1000,
      expiresAt: now + 3 * 60 * 60 * 1000
    }));
    expect(await stub.getRequest(active.requestId)).not.toBeNull();
  });

  it("does not mutate durable state while listing pending requests", async () => {
    const stub = store("read-only-list");
    const expiredId = "nfx_expiredaaaaaaaaaaaaaaaaa";
    await stub.createRequest(pending({
      requestId: expiredId,
      callbackHash: "c".repeat(64),
      createdAt: 1_000,
      expiresAt: 2_000
    }));

    expect(await stub.listPending(10, 3_000)).toEqual([]);
    expect(await stub.getRequest(expiredId)).not.toBeNull();
  });

  it("schedules durable maintenance for new requests without requiring another request", async () => {
    const raw = rawStore("retention-alarm-scheduled");
    const now = Date.now();
    await (raw as unknown as RequestStoreStub).createRequest(pending({
      createdAt: now,
      expiresAt: now + 300_000
    }));

    await runInDurableObject(raw, async (_instance, state) => {
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).not.toBeNull();
      expect(nextAlarm!).toBeGreaterThan(now);
      expect(nextAlarm!).toBeLessThanOrEqual(now + 300_001);
    });
  });

  it("alarm removes expired pending and old resolved rows but retains active requests", async () => {
    const raw = rawStore("retention-alarm-cleanup");
    const stub = raw as unknown as RequestStoreStub;
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const live = pending({ requestId: "nfx_liveaaaaaaaaaaaaaaaaaaaa", callbackHash: "d".repeat(64), createdAt: now, expiresAt: now + day });
    const expired = pending({ requestId: "nfx_expiredaaaaaaaaaaaaaaaaa", callbackHash: "e".repeat(64), createdAt: now - 15 * day, expiresAt: now - 14 * day });
    const resolved = pending({ requestId: "nfx_resolvedaaaaaaaaaaaaaaaa", callbackHash: "f".repeat(64), createdAt: now - 15 * day, expiresAt: now + day });

    await stub.createRequest(live);
    await stub.createRequest(expired);
    await stub.createRequest(resolved);
    await stub.resolveByCallbackHash({ callbackHash: resolved.callbackHash, decision: "deny", nowMs: now - 8 * day });
    expect(await stub.getRequest(expired.requestId)).not.toBeNull();
    expect((await stub.getRequest(resolved.requestId))?.status).toBe("resolved");

    await runInDurableObject(raw, async (instance) => {
      await instance.alarm();
    });
    expect(await stub.getRequest(expired.requestId)).toBeNull();
    expect(await stub.getRequest(resolved.requestId)).toBeNull();
    expect(await stub.getRequest(live.requestId)).not.toBeNull();
  });
});
