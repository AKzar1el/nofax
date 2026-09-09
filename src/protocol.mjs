import { randomBytes } from 'node:crypto';

const SECRET_KEY = /(?:^|[_-])(token|password|passwd|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_SUMMARY = 2200;

function randomBase64Url(bytes) {
  return randomBytes(bytes).toString('base64url');
}

export function createRequestId() {
  return `nfx_${randomBase64Url(18)}`;
}

export function createResponseTopic() {
  return `nofax_r_${randomBase64Url(24)}`;
}

export function createPhoneTopic() {
  return `nofax_${randomBase64Url(24)}`;
}

function boundString(value) {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…[truncated]`;
}

export function redactAndBound(value, options = {}) {
  const seen = options.seen ?? new WeakSet();
  const depth = options.depth ?? 0;

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return boundString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (typeof value !== 'object') return boundString(String(value));

  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactAndBound(item, { seen, depth: depth + 1 }));
  }

  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    out[key] = SECRET_KEY.test(key)
      ? '[REDACTED]'
      : redactAndBound(child, { seen, depth: depth + 1 });
  }
  return out;
}

function serializeBounded(value) {
  let serialized;
  try {
    serialized = JSON.stringify(redactAndBound(value), null, 2);
  } catch {
    serialized = '[unserializable]';
  }
  if (serialized.length <= 1400) return serialized;
  return `${serialized.slice(0, 1400)}\n…[truncated]`;
}

export function buildAgentSummary({ source, toolName, cwd, toolInput, message }) {
  const lines = [];
  if (source) lines.push(`Source: ${boundString(String(source))}`);
  if (toolName) lines.push(`Tool: ${boundString(String(toolName))}`);
  if (cwd) lines.push(`Working directory: ${boundString(String(cwd))}`);
  if (message) lines.push('', boundString(String(message)));
  if (toolInput !== undefined) lines.push('', 'Request:', serializeBounded(toolInput));
  const result = lines.join('\n').trim();
  if (result.length <= MAX_SUMMARY) return result;
  return `${result.slice(0, MAX_SUMMARY - 14)}\n…[truncated]`;
}

export function parseDecisionMessage(message, { requestId, allowed }) {
  if (typeof message !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== 1 || parsed.requestId !== requestId || typeof parsed.decision !== 'string') {
    return null;
  }
  return allowed.includes(parsed.decision) ? parsed.decision : null;
}
