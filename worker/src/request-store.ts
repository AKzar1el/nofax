import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { boundText, isWellFormedText } from "./protocol";

const REQUEST_ID = /^nfx_[A-Za-z0-9_-]{20,80}$/;
const CALLBACK_HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["approval", "choice", "refinement"] as const);
const STATUSES = new Set(["pending", "resolved"] as const);
const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_ALARM_MIN_DELAY_MS = 60 * 1000;
// Durable Object alarms have a narrower supported date range than JS Date.
// Human approval records do not need expiry timestamps decades into the future.
const MAX_REQUEST_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const INVALID_STORED_ROW_ERRORS = new Set([
  "NOFAX_REQUEST_ROW_INVALID",
  "NOFAX_REQUEST_ID_INVALID",
  "NOFAX_REQUEST_ALLOWED_INVALID",
  "NOFAX_CALLBACK_HASH_INVALID"
]);

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
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_REQUEST_TIMESTAMP_MS) {
    throw new Error(`NOFAX_${name}_INVALID`);
  }
  return Number(value);
}

function validateAllowed(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  const allowed = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 80 || !isWellFormedText(item)) {
      throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
    }
    return item.trim();
  });
  if (new Set(allowed).size !== allowed.length) throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  return allowed;
}

function validateAllowedForKind(kind: RequestKind, input: unknown): string[] {
  const allowed = validateAllowed(input);
  // A persisted approval cannot become an arbitrary choice by substituting
  // its allow-list, including when reading legacy or corrupted SQL rows.
  if (kind === "approval" &&
      (!allowed.includes("allow") || !allowed.includes("deny") ||
       allowed.some((decision) => !["allow", "deny", "refine"].includes(decision)))) {
    throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  }
  if (kind === "refinement" && (allowed.length !== 1 || allowed[0] !== "refine")) {
    throw new Error("NOFAX_REQUEST_ALLOWED_INVALID");
  }
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
    allowed: validateAllowedForKind(input.kind, input.allowed),
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

function validStoredText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength && isWellFormedText(value);
}

function rowToRequest(row: RequestRow): StoredRequest {
  const status = row.status as RequestStatus;
  const kind = row.kind as RequestKind;
  if (!STATUSES.has(status) || !KINDS.has(kind)) throw new Error("NOFAX_REQUEST_ROW_INVALID");
  // A legacy pending row containing a terminal denial or private refinement
  // must not be re-opened or offered for a second, conflicting decision.
  if (status === "pending" &&
      (row.decision !== null || row.resolved_at !== null || row.text !== null)) {
    throw new Error("NOFAX_REQUEST_ROW_INVALID");
  }
  // Legacy/corrupt rows bypass insertion-time checks; never expose invalid
  // dates through remote inspection or treat them as actionable approvals.
  const validStoredTimestamp = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_REQUEST_TIMESTAMP_MS;
  if (!validStoredTimestamp(row.created_at) || !validStoredTimestamp(row.expires_at) ||
      row.expires_at <= row.created_at) {
    throw new Error("NOFAX_REQUEST_ROW_INVALID");
  }
  // Legacy SQL rows bypass insertion-time text limits. Never return corrupt or
  // oversized human-facing content through inspection or decision lookups.
  if (!validStoredText(row.title, 120) || !validStoredText(row.message, 2200)) {
    throw new Error("NOFAX_REQUEST_ROW_INVALID");
  }
  const result: StoredRequest = {
    requestId: validateRequestId(row.request_id),
    kind,
    status,
    title: row.title,
    message: row.message,
    allowed: validateAllowedForKind(kind, parseAllowed(row.allowed_json)),
    callbackHash: validateCallbackHash(row.callback_hash),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
  if (status === "resolved") {
    // "refine" may also be the literal value of a choice option. Only an
    // approval/refinement response requires human-authored refinement text.
    const needsRefinementText = row.decision === "refine" && kind !== "choice";
    if (typeof row.decision !== "string" || !result.allowed.includes(row.decision) ||
        !validStoredTimestamp(row.resolved_at) ||
        row.resolved_at < row.created_at ||
        row.resolved_at > row.expires_at ||
        (!needsRefinementText && row.text !== null) ||
        (needsRefinementText && !validStoredText(row.text, 2000)) ||
        (row.text !== null && !validStoredText(row.text, 2000))) {
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
    // Old deployments may already contain rows, but have no scheduled alarm.
    // Register maintenance without deleting anything during read-only inspection.
    this.ctx.blockConcurrencyWhile(() => this.ensureRetentionAlarm());
  }

  private async ensureRetentionAlarm(additionalDue?: number): Promise<void> {
    const [row] = this.ctx.storage.sql.exec<{ due: number | null }>(
      `SELECT MIN(CASE
        WHEN status = 'pending' THEN expires_at + 1
        WHEN status = 'resolved' AND resolved_at BETWEEN 0 AND ? THEN resolved_at + ? + 1
        ELSE NULL
      END) AS due FROM requests
      WHERE created_at BETWEEN 0 AND ?
        AND expires_at BETWEEN 0 AND ?
        AND expires_at > created_at`,
      MAX_REQUEST_TIMESTAMP_MS,
      RESOLVED_RETENTION_MS,
      MAX_REQUEST_TIMESTAMP_MS,
      MAX_REQUEST_TIMESTAMP_MS
    ).toArray();
    const due = Math.min(row?.due ?? Infinity, additionalDue ?? Infinity);
    if (!Number.isFinite(due)) return;

    // A delayed/legacy row should not trigger an immediate alarm in the caller.
    const scheduledAt = Math.max(Date.now() + RETENTION_ALARM_MIN_DELAY_MS, due);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > scheduledAt) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  async alarm(): Promise<void> {
    this.cleanup(Date.now());
    // Keep only one alarm: the next pending expiry or resolved retention deadline.
    await this.ensureRetentionAlarm();
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

  async createRequest(input: PendingRequestInput): Promise<StoredRequest> {
    const request = normalizePending(input);
    // A client clock ahead of the Worker must not erase still-live approvals.
    // Retention may use an older request time, but never a future one.
    this.cleanup(Math.min(request.createdAt, Date.now()));
    // Establish the alarm before persistence, so a scheduling failure cannot
    // leave a newly persisted request whose lifetime has no maintenance timer.
    await this.ensureRetentionAlarm(request.expiresAt + 1);
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
    if (input.decision === "refine" && current.kind !== "choice") {
      if (typeof input.text !== "string" || !input.text.trim()) throw new Error("NOFAX_REQUEST_TEXT_INVALID");
      const trimmed = input.text.trim();
      // Reject lone UTF-16 surrogates before writing a terminal human decision.
      if (!isWellFormedText(trimmed)) throw new Error("NOFAX_REQUEST_TEXT_INVALID");
      const last = trimmed.charCodeAt(1_999);
      // Do not split a supplementary Unicode character across the UTF-16 limit.
      const end = trimmed.length > 2_000 && last >= 0xd800 && last <= 0xdbff ? 1_999 : 2_000;
      text = trimmed.slice(0, end);
    }

    // A corrected-backward clock must not persist a terminal event before
    // the request was created. Keep expiry validation based on actual nowMs.
    const resolvedAt = Math.max(nowMs, current.createdAt);

    const writtenRows = this.ctx.storage.sql.exec<RequestRow>(
      `UPDATE requests
       SET status = 'resolved', decision = ?, text = ?, resolved_at = ?
       WHERE callback_hash = ? AND status = 'pending' AND expires_at >= ?
       RETURNING *`,
      input.decision,
      text,
      resolvedAt,
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
    // Look past a bounded number of corrupt legacy rows so one cannot hide
    // otherwise valid approvals from read-only recovery inspection.
    const scanLimit = limit * 5; // At most 500 rows, even for a corrupt legacy store.
    const rows = this.ctx.storage.sql.exec<RequestRow>(
      `SELECT * FROM requests
       WHERE status = 'pending' AND expires_at >= ?
       ORDER BY created_at DESC, request_id DESC
       LIMIT ?`,
      now,
      scanLimit
    ).toArray();
    const requests: StoredRequest[] = [];
    for (const row of rows) {
      try {
        requests.push(rowToRequest(row));
      } catch (error) {
        if (!(error instanceof Error) || !INVALID_STORED_ROW_ERRORS.has(error.message)) throw error;
      }
      if (requests.length === limit) break;
    }
    // Never report a seemingly complete recovery list if corruption exhausted
    // the scan window and older valid requests might still be hidden.
    if (requests.length < limit && rows.length === scanLimit) {
      throw new Error("NOFAX_REQUEST_INSPECTION_LIMIT");
    }
    return requests;
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
