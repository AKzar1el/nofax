import { chmod, link, mkdir, open, opendir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeServer, resolveNofaxHome } from './config.mjs';

const REQUEST_ID = /^nfx_[A-Za-z0-9_-]{20,80}$/;
const RESPONSE_TOPIC = /^nofax_r_[A-Za-z0-9_-]{20,120}$/;
const PHONE_TOPIC = /^[A-Za-z0-9_-]{24,128}$/;
const KINDS = new Set(['approval', 'choice', 'refinement']);
const STATUSES = new Set(['pending', 'resolved']);
const MAX_RESPONSE_TEXT = 2000;
const MAX_REQUEST_RECORD_BYTES = 64 * 1024;
const TRUNCATION_MARKER = '…[truncated]';

function validateRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error('NOFAX_REQUEST_ID_INVALID');
  return value;
}

function safeSliceEnd(text, end) {
  const previous = text.charCodeAt(end - 1);
  return previous >= 0xD800 && previous <= 0xDBFF ? end - 1 : end;
}

function boundResponseText(value) {
  const text = value.trim();
  if (text.length <= MAX_RESPONSE_TEXT) return text;
  const end = safeSliceEnd(text, MAX_RESPONSE_TEXT - TRUNCATION_MARKER.length);
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

function validateRequest(input) {
  if (!input || input.version !== 1) throw new Error('NOFAX_REQUEST_VERSION');
  const requestId = validateRequestId(input.requestId);
  if (!KINDS.has(input.kind)) throw new Error('NOFAX_REQUEST_KIND_INVALID');
  if (typeof input.responseTopic !== 'string' || !RESPONSE_TOPIC.test(input.responseTopic)) throw new Error('NOFAX_RESPONSE_TOPIC_INVALID');
  if (!Array.isArray(input.allowed) || input.allowed.length < 1 || input.allowed.length > 3 || input.allowed.some((value) => typeof value !== 'string')) {
    throw new Error('NOFAX_REQUEST_ALLOWED_INVALID');
  }
  const allowed = input.allowed.map((value) => value.trim());
  if (allowed.some((value) => !value || value.length > 80) || new Set(allowed).size !== allowed.length) {
    throw new Error('NOFAX_REQUEST_ALLOWED_INVALID');
  }
  // An imported record cannot turn an approval or refinement into an
  // arbitrary choice by changing its stored allowed values.
  if (input.kind === 'approval' &&
      (!allowed.includes('allow') || !allowed.includes('deny') ||
       allowed.some((value) => !['allow', 'deny', 'refine'].includes(value)))) {
    throw new Error('NOFAX_REQUEST_ALLOWED_INVALID');
  }
  if (input.kind === 'refinement' && (allowed.length !== 1 || allowed[0] !== 'refine')) {
    throw new Error('NOFAX_REQUEST_ALLOWED_INVALID');
  }
  if (!STATUSES.has(input.status)) throw new Error('NOFAX_REQUEST_STATUS_INVALID');
  if (input.status === 'pending' &&
      (input.resolvedAt !== undefined || input.decision !== undefined || input.text !== undefined)) {
    // Do not silently strip a legacy denial or private human text and then
    // treat its record as a fresh, unresolved approval request.
    throw new Error('NOFAX_REQUEST_PENDING_TERMINAL_FIELDS_INVALID');
  }
  const createdAtMs = typeof input.createdAt === 'string' ? Date.parse(input.createdAt) : NaN;
  if (!Number.isFinite(createdAtMs)) throw new Error('NOFAX_REQUEST_CREATED_AT_INVALID');
  const hasServer = input.server !== undefined;
  const hasTopic = input.topic !== undefined;
  if (hasServer !== hasTopic) throw new Error('NOFAX_REQUEST_TRANSPORT_INVALID');
  const base = {
    version: 1,
    requestId,
    kind: input.kind,
    responseTopic: input.responseTopic,
    allowed,
    status: input.status,
    createdAt: input.createdAt
  };
  if (hasServer) {
    if (typeof input.server !== 'string' || typeof input.topic !== 'string' || !PHONE_TOPIC.test(input.topic)) {
      throw new Error('NOFAX_REQUEST_TRANSPORT_INVALID');
    }
    base.server = normalizeServer(input.server);
    base.topic = input.topic;
  }
  if (input.status === 'resolved') {
    const resolvedAtMs = typeof input.resolvedAt === 'string' ? Date.parse(input.resolvedAt) : NaN;
    // A terminal decision cannot precede the request it purportedly resolved.
    if (!Number.isFinite(resolvedAtMs) || resolvedAtMs < createdAtMs) throw new Error('NOFAX_REQUEST_RESOLVED_AT_INVALID');
    if (typeof input.decision !== 'string') throw new Error('NOFAX_REQUEST_DECISION_INVALID');
    const decision = input.decision.trim();
    if (!allowed.includes(decision)) throw new Error('NOFAX_REQUEST_DECISION_INVALID');
    // Only a refinement can carry human text; reject corrupt legacy sidecars
    // and unexpected direct responses rather than persisting private content.
    if (decision !== 'refine' && input.text !== undefined) throw new Error('NOFAX_REQUEST_TEXT_INVALID');
    if (decision === 'refine' && input.kind !== 'choice' && (typeof input.text !== 'string' || !input.text.trim())) {
      throw new Error('NOFAX_REQUEST_TEXT_INVALID');
    }
    base.resolvedAt = input.resolvedAt;
    base.decision = decision;
    if (input.text !== undefined) {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('NOFAX_REQUEST_TEXT_INVALID');
      base.text = boundResponseText(input.text);
    }
  }
  return base;
}

function paths({ home, env, requestId }) {
  const root = resolveNofaxHome({ home, env });
  const requestsRoot = join(root, 'requests');
  const normalizedRequestId = validateRequestId(requestId);
  return {
    requestsRoot,
    file: join(requestsRoot, `${normalizedRequestId}.json`),
    terminal: join(requestsRoot, `${normalizedRequestId}.terminal.json`)
  };
}

async function readBoundedRecord(path, tooLargeCode, invalidUtf8Code) {
  const file = await open(path, 'r');
  try {
    // A corrupt local request record must not allocate unbounded memory during
    // status inspection, cleanup, or recovery of a terminal human decision.
    const buffer = Buffer.allocUnsafe(MAX_REQUEST_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_REQUEST_RECORD_BYTES) throw new Error(tooLargeCode);
    try {
      // A replacement character must not silently change persisted human
      // decisions or refinement text when a request record is corrupted.
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error(invalidUtf8Code);
    }
  } finally {
    await file.close();
  }
}

async function loadTerminalClaim(path, requestId) {
  try {
    const terminal = validateRequest(JSON.parse(await readBoundedRecord(path, 'NOFAX_REQUEST_TERMINAL_TOO_LARGE', 'NOFAX_REQUEST_TERMINAL_INVALID_UTF8')));
    if (terminal.status !== 'resolved') throw new Error('NOFAX_REQUEST_TERMINAL_INVALID');
    if (terminal.requestId !== requestId) throw new Error('NOFAX_REQUEST_ID_MISMATCH');
    return terminal;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('NOFAX_REQUEST_TERMINAL_INVALID_JSON');
    throw error;
  }
}

async function createExclusiveRecord(path, value) {
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  // Exclusive creation prevents a pre-existing hardlink or symlink from
  // redirecting writes; cleanup is limited to the temporary file we created.
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await chmod(temp, 0o600); } catch {}
    try {
      await link(temp, path);
      try { await chmod(path, 0o600); } catch {}
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try { await unlink(temp); } catch {}
  }
}

export async function savePendingRequest({ home, env, request }) {
  const normalized = validateRequest(request);
  if (normalized.status !== 'pending') throw new Error('NOFAX_REQUEST_NOT_PENDING');
  const { requestsRoot, file, terminal } = paths({ home, env, requestId: normalized.requestId });
  await mkdir(requestsRoot, { recursive: true, mode: 0o700 });
  if (await loadTerminalClaim(terminal, normalized.requestId) !== null) {
    throw new Error('NOFAX_REQUEST_ALREADY_EXISTS');
  }
  if (!await createExclusiveRecord(file, normalized)) {
    throw new Error('NOFAX_REQUEST_ALREADY_EXISTS');
  }
  return normalized;
}

export async function discardPendingRequest({ home, env, requestId }) {
  const { file, terminal } = paths({ home, env, requestId });
  if (await loadTerminalClaim(terminal, requestId) !== null) return false;
  try {
    const current = validateRequest(JSON.parse(await readBoundedRecord(file, 'NOFAX_REQUEST_TOO_LARGE', 'NOFAX_REQUEST_INVALID_UTF8')));
    if (current.requestId !== requestId) throw new Error('NOFAX_REQUEST_ID_MISMATCH');
    if (current.status !== 'pending') return false;
    await unlink(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error instanceof SyntaxError) throw new Error('NOFAX_REQUEST_INVALID_JSON');
    throw error;
  }
}

export async function loadRequest({ home, env, requestId }) {
  const { file, terminal } = paths({ home, env, requestId });
  const claimed = await loadTerminalClaim(terminal, requestId);
  if (claimed !== null) return claimed;
  try {
    const request = validateRequest(JSON.parse(await readBoundedRecord(file, 'NOFAX_REQUEST_TOO_LARGE', 'NOFAX_REQUEST_INVALID_UTF8')));
    if (request.requestId !== requestId) throw new Error('NOFAX_REQUEST_ID_MISMATCH');
    return request;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('NOFAX_REQUEST_NOT_FOUND');
    if (error instanceof SyntaxError) throw new Error('NOFAX_REQUEST_INVALID_JSON');
    throw error;
  }
}

export async function resolveRequestWithClaim({ home, env, requestId, response, resolvedAt = new Date().toISOString() }) {
  const current = await loadRequest({ home, env, requestId });
  if (current.status === 'resolved') return { request: current, claimed: false };
  if (!response || typeof response.decision !== 'string') throw new Error('NOFAX_REQUEST_DECISION_INVALID');
  const decision = response.decision.trim();
  if (!current.allowed.includes(decision)) throw new Error('NOFAX_REQUEST_DECISION_INVALID');
  const resolved = validateRequest({
    ...current,
    status: 'resolved',
    resolvedAt,
    decision,
    ...(response.text === undefined ? {} : { text: response.text })
  });
  const { terminal } = paths({ home, env, requestId });
  if (!await createExclusiveRecord(terminal, resolved)) {
    return { request: await loadRequest({ home, env, requestId }), claimed: false };
  }
  return { request: resolved, claimed: true };
}

export async function resolveRequest(options) {
  return (await resolveRequestWithClaim(options)).request;
}

export async function listPendingRequests({ home, env, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('NOFAX_REQUEST_LIMIT_INVALID');
  const root = resolveNofaxHome({ home, env });
  const requestsRoot = join(root, 'requests');
  let directory;
  try {
    directory = await opendir(requestsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  const newestFirst = (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.requestId.localeCompare(left.requestId);
  for await (const { name } of directory) {
    if (!name.endsWith('.json')) continue;
    const requestId = name.slice(0, -5);
    if (!REQUEST_ID.test(requestId)) continue;
    try {
      const request = await loadRequest({ home: root, requestId });
      if (request.status !== 'pending') continue;
      // Scan every file to retain fail-closed validation, but keep only the newest limit records in memory.
      if (results.length === limit && newestFirst(request, results[results.length - 1]) >= 0) continue;
      results.push(request);
      results.sort(newestFirst);
      if (results.length > limit) results.pop();
    } catch (error) {
      if (error?.message === 'NOFAX_REQUEST_NOT_FOUND') continue;
      throw error;
    }
  }
  return results;
}
