import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { boundText } from "./protocol";

const REQUEST_ID = /^nfx_[A-Za-z0-9_-]{20,80}$/;
const CALLBACK_HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["approval", "choice", "refinement"] as const);
const STATUSES = new Set(["pending", "resolved"] as const);
const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RequestKind = "approval" | "choice" | "refinement";
export type RequestStatus = "pending" | "resolved";

export interface PendingRequestInput {
  requestId: string;
  kind: RequestKind;
  title: string;
  message: string;
  allowed: string[];
  callbackHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredRequest extends PendingRequestInput {
  status: RequestStatus;
  decision?: string;
  text?: string;
  resolvedAt?: number;
}

export interface ResolveInput {
  callbackHash: string;
  decision: string;
  text?: string;
  nowMs: number;
}

export interface ResolveResult {
  request: StoredRequest;
  newlyResolved: boolean;
}

type RequestRow = {
  request_id: string;
  kind: string;
  status: string;
  title: string;
  message: string;
  allowed_json: string;
  callback_hash: string;
  decision: string | null;
  text: string | null;
  created_at: number;
  resolved_at: number | null;
  expires_at: number;
};

function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new Error("NOFAX_REQUEST_ID_INVALID");
  return value;
}

function validateCallbackHash(value: unknown): string {
  if (typeof value !== "string" || !CALLBACK_HASH.test(value)) throw new Error("NOFAX_CALLBACK_HASH_INVALID");
  return value;
}

function validateTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`NOFAX_${name}_INVALID`);
  return Number(value);
}

function validateAllowed(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  const allowed = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 80) throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
    return item.trim();
  });
  if (new Set(allowed).size !== allowed.length) throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  return allowed;
}

function normalizePending(input: PendingRequestInput): PendingRequestInput {
  const requestId = validateRequestId(input?.requestId);
  if (!KINDS.has(input?.kind)) throw new Error("NOFAX_REQUEST_KIND_INVALID");
  const createdAt = validateTimestamp(input?.createdAt, "REQUEST_CREATED_AT");
  const expiresAt = validateTimestamp(input?.expiresAt, "REQUEST_EXPIRES_AT");
  if (expiresAt <= createdAt) throw new Error("NOFAX_REQUEST_EXPIRY_INVALID");
  return {
    requestId,
    kind: input.kind,
    title: boundText(input.title, 120, "TITLE"),
    message: boundText(input.message, 2200, "MESSAGE"),
    allowed: validateAllowed(input.allowed),
    callbackHash: validateCallbackHash(input.callbackHash),
    createdAt,
    expiresAt
  };
}

function parseAllowed(value: string): string[] {
  try {
    return validateAllowed(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message === "NOFAX_REQUEST_ALLOWED_INVALID") throw error;
    throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  }
}

function rowToRequest(row: RequestRow): StoredRequest {
  const status = row.status as RequestStatus;
  const kind = row.kind as RequestKind;
  if (!STATUSES.has(status) || !KINDS.has(kind)) throw new Error("NOFAX_REQUEST_ROW_INVALID");
  const result: StoredRequest = {
    requestId: validateRequestId(row.request_id),
    kind,
    status,
    title: row.title,
    message: row.message,
    allowed: parseAllowed(row.allowed_json),
    callbackHash: validateCallbackHash(row.callback_hash),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
  if (status === "resolved") {
    if (typeof row.decision !== "string" || !result.allowed.includes(row.decision) || row.resolved_at === null) {
      throw new Error("NOFAX_REQUEST_ROW_INVALID");
    }
    result.decision = row.decision;
    result.resolvedAt = row.resolved_at;
    if (row.text !== null) result.text = row.text;
  }
  return result;
}

export class NofaxRequestStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        allowed_json TEXT NOT NULL,
        callback_hash TEXT NOT NULL UNIQUE,
        decision TEXT,
        text TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_status_expires
        ON requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_requests_resolved_at
        ON requests(resolved_at);
    `);
  }

  private selectByRequestId(requestId: string): StoredRequest | null {
    const rows = this.ctx.storage.sql.exec<RequestRow>(
      "SELECT * FROM requests WHERE request_id = ? LIMIT 1",
      validateRequestId(requestId)
    ).toArray();
    return rows.length === 0 ? null : rowToRequest(rows[0]);
  }

  private selectByCallbackHash(callbackHash: string): StoredRequest | null {
    const rows = this.ctx.storage.sql.exec<RequestRow>(
      "SELECT * FROM requests WHERE callback_hash = ? LIMIT 1",
      validateCallbackHash(callbackHash)
    ).toArray();
    return rows.length === 0 ? null : rowToRequest(rows[0]);
  }

  createRequest(input: PendingRequestInput): StoredRequest {
    const request = normalizePending(input);
    this.cleanup(request.createdAt);
    this.ctx.storage.sql.exec(
      `INSERT INTO requests (
        request_id, kind, status, title, message, allowed_json, callback_hash,
        decision, text, created_at, resolved_at, expires_at
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`,
      request.requestId,
      request.kind,
      request.title,
      request.message,
      JSON.stringify(request.allowed),
      request.callbackHash,
      request.createdAt,
      request.expiresAt
    );
    return { ...request, status: "pending" };
  }

  getRequest(requestId: string): StoredRequest | null {
    return this.selectByRequestId(requestId);
  }

  getByCallbackHash(callbackHash: string, nowMs: number): StoredRequest | null {
    const now = validateTimestamp(nowMs, "NOW");
    const request = this.selectByCallbackHash(callbackHash);
    if (request === null || request.expiresAt < now) return null;
    return request;
  }

  resolveByCallbackHash(input: ResolveInput): ResolveResult | null {
    const callbackHash = validateCallbackHash(input?.callbackHash);
    const nowMs = validateTimestamp(input?.nowMs, "NOW");
    const current = this.selectByCallbackHash(callbackHash);
    if (current === null || current.expiresAt < nowMs) return null;
    if (current.status === "resolved") return { request: current, newlyResolved: false };
    if (typeof input.decision !== "string" || !current.allowed.includes(input.decision)) {
      throw new Error("NOFAX_REQUEST_DECISION_INVALID");
    }

    let text: string | null = null;
    if (input.decision === "refine") {
      if (typeof input.text !== "string" || !input.text.trim()) throw new Error("NOFAX_REQUEST_TEXT_INVALID");
      text = input.text.trim().slice(0, 2000);
    }

    const writtenRows = this.ctx.storage.sql.exec<RequestRow>(
      `UPDATE requests
       SET status = 'resolved', decision = ?, text = ?, resolved_at = ?
       WHERE callback_hash = ? AND status = 'pending' AND expires_at >= ?
       RETURNING *`,
      input.decision,
      text,
      nowMs,
      callbackHash,
      nowMs
    ).toArray();
    if (writtenRows.length === 1) {
      return { request: rowToRequest(writtenRows[0]), newlyResolved: true };
    }

    const resolved = this.selectByCallbackHash(callbackHash);
    if (resolved === null || resolved.status !== "resolved") return null;
    return { request: resolved, newlyResolved: false };
  }

  deleteRequest(requestId: string): boolean {
    const cursor = this.ctx.storage.sql.exec(
      "DELETE FROM requests WHERE request_id = ?",
      validateRequestId(requestId)
    );
    return cursor.rowsWritten > 0;
  }

  listPending(limit = 20, nowMs = Date.now()): StoredRequest[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("NOFAX_REQUEST_LIMIT_INVALID");
    const now = validateTimestamp(nowMs, "NOW");
    this.cleanup(now);
    return this.ctx.storage.sql.exec<RequestRow>(
      `SELECT * FROM requests
       WHERE status = 'pending' AND expires_at >= ?
       ORDER BY created_at ASC, request_id ASC
       LIMIT ?`,
      now,
      limit
    ).toArray().map(rowToRequest);
  }

  cleanup(nowMs = Date.now()): number {
    const now = validateTimestamp(nowMs, "NOW");
    const expired = this.ctx.storage.sql.exec(
      "DELETE FROM requests WHERE status = 'pending' AND expires_at < ?",
      now
    );
    const resolved = this.ctx.storage.sql.exec(
      "DELETE FROM requests WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?",
      now - RESOLVED_RETENTION_MS
    );
    return expired.rowsWritten + resolved.rowsWritten;
  }
}
