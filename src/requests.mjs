import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveNofaxHome } from './config.mjs';

const REQUEST_ID = /^nfx_[A-Za-z0-9_-]{20,80}$/;
const RESPONSE_TOPIC = /^nofax_r_[A-Za-z0-9_-]{20,120}$/;
const KINDS = new Set(['approval', 'choice', 'refinement']);
const STATUSES = new Set(['pending', 'resolved']);

function validateRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error('NOFAX_REQUEST_ID_INVALID');
  return value;
}

function validateRequest(input) {
  if (!input || input.version !== 1) throw new Error('NOFAX_REQUEST_VERSION');
  const requestId = validateRequestId(input.requestId);
  if (!KINDS.has(input.kind)) throw new Error('NOFAX_REQUEST_KIND_INVALID');
  if (typeof input.responseTopic !== 'string' || !RESPONSE_TOPIC.test(input.responseTopic)) throw new Error('NOFAX_RESPONSE_TOPIC_INVALID');
  if (!Array.isArray(input.allowed) || input.allowed.length < 1 || input.allowed.length > 3 || input.allowed.some((value) => typeof value !== 'string' || !value || value.length > 80)) {
    throw new Error('NOFAX_REQUEST_ALLOWED_INVALID');
  }
  if (!STATUSES.has(input.status)) throw new Error('NOFAX_REQUEST_STATUS_INVALID');
  if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt))) throw new Error('NOFAX_REQUEST_CREATED_AT_INVALID');
  const base = {
    version: 1,
    requestId,
    kind: input.kind,
    responseTopic: input.responseTopic,
    allowed: [...input.allowed],
    status: input.status,
    createdAt: input.createdAt
  };
  if (input.status === 'resolved') {
    if (typeof input.resolvedAt !== 'string' || Number.isNaN(Date.parse(input.resolvedAt))) throw new Error('NOFAX_REQUEST_RESOLVED_AT_INVALID');
    if (typeof input.decision !== 'string' || !input.allowed.includes(input.decision)) throw new Error('NOFAX_REQUEST_DECISION_INVALID');
    base.resolvedAt = input.resolvedAt;
    base.decision = input.decision;
    if (input.text !== undefined) {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('NOFAX_REQUEST_TEXT_INVALID');
      base.text = input.text.trim().slice(0, 2000);
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

async function atomicWrite(path, value) {
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(temp, 0o600); } catch {}
  await rename(temp, path);
  try { await chmod(path, 0o600); } catch {}
}

async function loadTerminalClaim(path) {
  try {
    const terminal = validateRequest(JSON.parse(await readFile(path, 'utf8')));
    if (terminal.status !== 'resolved') throw new Error('NOFAX_REQUEST_TERMINAL_INVALID');
    return terminal;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('NOFAX_REQUEST_TERMINAL_INVALID_JSON');
    throw error;
  }
}

async function claimTerminal(path, value) {
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(temp, 0o600); } catch {}

  try {
    await link(temp, path);
    try { await chmod(path, 0o600); } catch {}
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { await unlink(temp); } catch {}
  }
}

export async function savePendingRequest({ home, env, request }) {
  const normalized = validateRequest(request);
  if (normalized.status !== 'pending') throw new Error('NOFAX_REQUEST_NOT_PENDING');
  const { requestsRoot, file } = paths({ home, env, requestId: normalized.requestId });
  await mkdir(requestsRoot, { recursive: true, mode: 0o700 });
  await atomicWrite(file, normalized);
  return normalized;
}

export async function loadRequest({ home, env, requestId }) {
  const { file, terminal } = paths({ home, env, requestId });
  const claimed = await loadTerminalClaim(terminal);
  if (claimed !== null) return claimed;
  try {
    return validateRequest(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('NOFAX_REQUEST_NOT_FOUND');
    if (error instanceof SyntaxError) throw new Error('NOFAX_REQUEST_INVALID_JSON');
    throw error;
  }
}

export async function resolveRequestWithClaim({ home, env, requestId, response, resolvedAt = new Date().toISOString() }) {
  const current = await loadRequest({ home, env, requestId });
  if (current.status === 'resolved') return { request: current, claimed: false };
  if (!response || typeof response.decision !== 'string' || !current.allowed.includes(response.decision)) throw new Error('NOFAX_REQUEST_DECISION_INVALID');
  const resolved = validateRequest({
    ...current,
    status: 'resolved',
    resolvedAt,
    decision: response.decision,
    ...(response.text === undefined ? {} : { text: response.text })
  });
  const { terminal } = paths({ home, env, requestId });
  if (!await claimTerminal(terminal, resolved)) {
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
  let names;
  try {
    names = await readdir(requestsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const requestId = name.slice(0, -5);
    if (!REQUEST_ID.test(requestId)) continue;
    try {
      const request = await loadRequest({ home: root, requestId });
      if (request.status === 'pending') results.push(request);
    } catch {}
  }
  return results
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.requestId.localeCompare(left.requestId))
    .slice(0, limit);
}
