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

  it("rejects request kinds with incompatible decision allow-lists before persistence", async () => {
    await runInDurableObject(rawStore("kind-allowed-invariant"), async (instance) => {
      for (const invalid of [
        pending({ allowed: ["allow", "execute"] }),
        pending({ allowed: ["allow"] }),
        pending({ kind: "refinement", allowed: ["allow", "deny"] }),
        pending({ kind: "refinement", allowed: ["refine", "deny"] })
      ]) {
        await expect(instance.createRequest(invalid)).rejects.toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
      }
      expect(instance.getRequest(pending().requestId)).toBeNull();
    });
  });

  it("rejects ill-formed Unicode in choice values before persistence and when reading legacy rows", async () => {
    const raw = rawStore("choice-invalid-unicode");
    const input = pending({ kind: "choice", allowed: ["ship", "hold"] });
    await runInDurableObject(raw, async (instance, state) => {
      await expect(instance.createRequest(pending({
        kind: "choice", allowed: ["ship", "bad" + String.fromCharCode(0xd800) + "value"]
      }))).rejects.toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
      expect(instance.getRequest(input.requestId)).toBeNull();

      await instance.createRequest(input);
      state.storage.sql.exec(
        "UPDATE requests SET allowed_json = ? WHERE request_id = ?",
        JSON.stringify(["ship", "bad" + String.fromCharCode(0xd800) + "value"]), input.requestId
      );
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
      expect(() => instance.resolveByCallbackHash({
        callbackHash: input.callbackHash, decision: "ship", nowMs: 2_000
      })).toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
    });
  });

  it("refuses corrupt legacy approval allow-lists before inspection or callback resolution", async () => {
    const raw = rawStore("legacy-kind-allowed-invariant");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending();
    await stub.createRequest(input);
    await runInDurableObject(raw, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET allowed_json = ? WHERE request_id = ?",
        JSON.stringify(["allow", "execute"]), input.requestId
      );
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
      expect(() => instance.resolveByCallbackHash({
        callbackHash: input.callbackHash, decision: "execute", nowMs: 2_000
      })).toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
      expect(instance.listPending(1, 2_000)).toEqual([]);
    });
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

  it("rejects legacy rows with corrupt timestamps before exposing request state", async () => {
    const raw = rawStore("corrupt-row-timestamps");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending();
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE requests SET created_at = -1 WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET created_at = 1000, expires_at = 999 WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET expires_at = 2000, status = 'resolved', decision = 'deny', resolved_at = -1 WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      // Imported/corrupt terminal rows must not invent a decision before creation.
      sql.exec("UPDATE requests SET resolved_at = 500 WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      expect(() => instance.getByCallbackHash(input.callbackHash, 1500)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      // A corrupt legacy row must not manufacture a human decision after expiry.
      sql.exec("UPDATE requests SET resolved_at = 2001 WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      expect(() => instance.getByCallbackHash(input.callbackHash, 1500)).toThrow("NOFAX_REQUEST_ROW_INVALID");
    });
  });

  it("rejects pending legacy rows containing terminal decision fields", async () => {
    const raw = rawStore("pending-with-terminal-columns");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending();
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance, state) => {
      for (const update of [
        "UPDATE requests SET decision = 'deny' WHERE request_id = ?",
        "UPDATE requests SET decision = NULL, resolved_at = 2000 WHERE request_id = ?",
        "UPDATE requests SET resolved_at = NULL, text = 'private' WHERE request_id = ?"
      ]) {
        state.storage.sql.exec(update, input.requestId);
        expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
        expect(() => instance.resolveByCallbackHash({
          callbackHash: input.callbackHash, decision: "allow", nowMs: 2_000
        })).toThrow("NOFAX_REQUEST_ROW_INVALID");
        expect(instance.listPending(1, 2_000)).toEqual([]);
      }
    });
  });

  it("rejects corrupt legacy notification text without hiding other pending approvals", async () => {
    const raw = rawStore("corrupt-row-text");
    const stub = raw as unknown as RequestStoreStub;
    const valid = pending({ requestId: "nfx_validtextaaaaaaaaaaaaaaaa", callbackHash: "b".repeat(64) });
    const corrupt = pending({
      requestId: "nfx_corrupttextaaaaaaaaaaaaaa", callbackHash: "c".repeat(64), createdAt: 2_000
    });
    await stub.createRequest(valid);
    await stub.createRequest(corrupt);

    await runInDurableObject(raw, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE requests SET title = '' WHERE request_id = ?", corrupt.requestId);
      expect(() => instance.getRequest(corrupt.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET title = 'Deploy?', message = ? WHERE request_id = ?", "x".repeat(2_201), corrupt.requestId);
      expect(() => instance.getRequest(corrupt.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET message = 'Safe', status = 'resolved', decision = 'allow', resolved_at = 3000, text = ? WHERE request_id = ?", "x".repeat(2_001), corrupt.requestId);
      expect(() => instance.getRequest(corrupt.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
    });
    expect((await stub.listPending(1, 3_000)).map((request) => request.requestId))
      .toEqual([valid.requestId]);
  });

  it("rejects a legacy resolved refinement without actual human text", async () => {
    const raw = rawStore("legacy-refinement-missing-text");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending({ kind: "refinement", allowed: ["refine"] });
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE requests SET status = 'resolved', decision = 'refine', resolved_at = 2000, text = NULL WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      expect(() => instance.getByCallbackHash(input.callbackHash, 2000)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET text = '   ' WHERE request_id = ?", input.requestId);
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");

      sql.exec("UPDATE requests SET text = 'change it' WHERE request_id = ?", input.requestId);
      expect(instance.getRequest(input.requestId)?.text).toBe("change it");
    });
  });

  it("rejects legacy non-refinement decisions carrying unexpected private text", async () => {
    const raw = rawStore("legacy-approval-unexpected-text");
    const stub = raw as unknown as RequestStoreStub;
    const input = pending();
    await stub.createRequest(input);

    await runInDurableObject(raw, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET status = 'resolved', decision = 'allow', resolved_at = 2000, text = 'unexpected private text' WHERE request_id = ?",
        input.requestId
      );
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      expect(() => instance.getByCallbackHash(input.callbackHash, 2000)).toThrow("NOFAX_REQUEST_ROW_INVALID");
    });
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

  it("preserves terminal chronology when the Worker clock moves backward", async () => {
    const stub = store("clock-rollback-terminal");
    const input = pending({ createdAt: 10_000, expiresAt: 20_000 });
    await stub.createRequest(input);

    const first = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "allow",
      nowMs: 5_000
    });
    expect(first?.newlyResolved).toBe(true);
    expect(first?.request.resolvedAt).toBe(input.createdAt);
    expect((await stub.getRequest(input.requestId))?.resolvedAt).toBe(input.createdAt);

    const second = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "deny",
      nowMs: 6_000
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

  it("accepts refine as an ordinary choice value without requiring refinement text", async () => {
    const stub = store("choice-option-named-refine");
    const input = pending({ kind: "choice", allowed: ["refine", "skip"] });
    await stub.createRequest(input);

    const result = await stub.resolveByCallbackHash({
      callbackHash: input.callbackHash,
      decision: "refine",
      nowMs: 2_000
    });
    expect(result?.newlyResolved).toBe(true);
    expect(result?.request.decision).toBe("refine");
    expect(result?.request.text).toBeUndefined();
    expect((await stub.getRequest(input.requestId))?.decision).toBe("refine");
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

  it("keeps valid pending requests inspectable when a newer legacy row is corrupt", async () => {
    const raw = rawStore("list-corrupt-legacy");
    const stub = raw as unknown as RequestStoreStub;
    const oldest = pending({
      requestId: "nfx_oldvalidaaaaaaaaaaaaaaaa", callbackHash: "a".repeat(64), createdAt: 1_000
    });
    const newest = pending({
      requestId: "nfx_newvalidaaaaaaaaaaaaaaaa", callbackHash: "b".repeat(64), createdAt: 2_000
    });
    const corrupt = pending({
      requestId: "nfx_corruptaaaaaaaaaaaaaaaa", callbackHash: "c".repeat(64), createdAt: 3_000
    });
    const corruptAllowed = pending({
      requestId: "nfx_corruptallowedaaaaaaaaaaa", callbackHash: "d".repeat(64), createdAt: 4_000
    });
    await stub.createRequest(oldest);
    await stub.createRequest(newest);
    await stub.createRequest(corrupt);
    await stub.createRequest(corruptAllowed);

    await runInDurableObject(raw, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET expires_at = ? WHERE request_id = ?",
        Date.UTC(2200, 0, 1),
        corrupt.requestId
      );
      state.storage.sql.exec(
        "UPDATE requests SET allowed_json = ? WHERE request_id = ?",
        "not-json",
        corruptAllowed.requestId
      );
      expect(() => instance.getRequest(corrupt.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      expect(() => instance.getRequest(corruptAllowed.requestId)).toThrow("NOFAX_REQUEST_ALLOWED_INVALID");
    });
    expect((await stub.listPending(1, 4_000)).map((request) => request.requestId))
      .toEqual([newest.requestId]);
    expect((await stub.listPending(2, 4_000)).map((request) => request.requestId))
      .toEqual([newest.requestId, oldest.requestId]);
  });

  it("fails closed rather than claim an empty list after exhausting corrupt-row scan bounds", async () => {
    const raw = rawStore("list-corrupt-scan-limit");
    const stub = raw as unknown as RequestStoreStub;
    const valid = pending({ requestId: "nfx_validbeyondcorruptaaaaaaa", callbackHash: "a".repeat(64) });
    await stub.createRequest(valid);
    for (let index = 0; index < 5; index += 1) {
      await stub.createRequest(pending({
        requestId: `nfx_corruptscan${index}${"a".repeat(20)}`,
        callbackHash: String(index + 1).repeat(64),
        createdAt: 2_000 + index
      }));
    }
    await runInDurableObject(raw, async (_instance, state) => {
      state.storage.sql.exec("UPDATE requests SET allowed_json = 'not-json' WHERE request_id != ?", valid.requestId);
    });
    await runInDurableObject(raw, async (instance) => {
      expect(() => instance.listPending(1, 4_000)).toThrow("NOFAX_REQUEST_INSPECTION_LIMIT");
    });
    expect(await stub.getRequest(valid.requestId)).not.toBeNull();
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

  it("does not schedule unsupported alarms from corrupt legacy dates", async () => {
    const raw = rawStore("legacy-out-of-range-alarm");
    const input = pending();
    await (raw as unknown as RequestStoreStub).createRequest(input);

    await runInDurableObject(raw, async (instance, state) => {
      // Legacy storage may predate insertion-time timestamp validation.
      state.storage.sql.exec(
        "UPDATE requests SET expires_at = ? WHERE request_id = ?",
        Date.UTC(2200, 0, 1),
        input.requestId
      );
      await state.storage.deleteAlarm();
      expect(() => instance.getRequest(input.requestId)).toThrow("NOFAX_REQUEST_ROW_INVALID");
      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();

      const now = Date.now();
      const valid = pending({
        requestId: "nfx_validaftercorruptaaaaaaaa",
        callbackHash: "b".repeat(64),
        createdAt: now,
        expiresAt: now + 300_000
      });
      await instance.createRequest(valid);
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(now + 300_001);
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
