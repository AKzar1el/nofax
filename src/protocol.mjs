import { randomBytes } from 'node:crypto';

const SECRET_KEY = /(?:^|[_-])(token|password|passwd|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_SUMMARY = 2200;
const MAX_RESPONSE_TEXT = 2000;

function normalizeSecretKeyName(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_');
}

function isSecretKey(key) {
  return SECRET_KEY.test(normalizeSecretKeyName(key));
}

function redactSecretText(value) {
  let redacted = value;

  redacted = redacted.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
    (_match, label) => `-----BEGIN ${label}-----\n[REDACTED]\n-----END ${label}-----`
  );

  redacted = redacted.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/)([^\s\/@:]*):([^\s\/@]+)@/g,
    '$1$2:[REDACTED]@'
  );

  redacted = redacted.replace(
    /(["'])((?:proxy[-_])?authorization)(?!\s*[:=]\s*(?:bearer|basic)\b)(\s*[:=]\s*)((?:\\.|(?!\1).)*)\1/gi,
    '$1$2$3[REDACTED]$1'
  );

  redacted = redacted.replace(
    /(^|[\r\n])([ \t]*)((?:proxy[-_])?authorization)(\s*[:=]\s*)[^\r\n]*/gim,
    '$1$2$3$4[REDACTED]'
  );

  redacted = redacted.replace(
    /\b((?:proxy[-_])?authorization)(\s*[:=]\s*)(bearer|basic)(\s+)([^\s"'`,;&]+)/gi,
    '$1$2$3$4[REDACTED]'
  );

  redacted = redacted.replace(
    /\b(set-cookie|cookie)(\s*:\s*)[^\r\n]*/gi,
    '$1$2[REDACTED]'
  );

  redacted = redacted.replace(
    /([?&])([A-Za-z][A-Za-z0-9_-]{0,63})=([^&\s"'`,;]+)/g,
    (match, prefix, key) => isSecretKey(key)
      ? `${prefix}${key}=[REDACTED]`
      : match
  );

  redacted = redacted.replace(
    /(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\1(\s*[:=]\s*)(["'])(.*?)\4/g,
    (match, keyQuote, key, separator, valueQuote) => isSecretKey(key)
      ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );

  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9_-]{0,63})(\s*[:=]\s*)(["'])(.*?)\3/g,
    (match, key, separator, valueQuote) => isSecretKey(key)
      ? `${key}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );

  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9_-]{0,63})(\s*[:=]\s*)([^\s"'`,;&]+)/g,
    (match, key, separator, rawValue) => {
      if (!isSecretKey(key)) return match;
      if (/authorization$/i.test(normalizeSecretKeyName(key)) && /^(?:bearer|basic)$/i.test(rawValue)) return match;
      return `${key}${separator}[REDACTED]`;
    }
  );

  redacted = redacted.replace(
    /--([A-Za-z][A-Za-z0-9_-]{0,63})(\s+)(["'](?:.*?)["']|[^\s"'`,;&]+)/g,
    (match, key, separator) => isSecretKey(key)
      ? `--${key}${separator}[REDACTED]`
      : match
  );

  return redacted;
}

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
  const redacted = redactSecretText(value);
  const bounded = redacted.length <= MAX_STRING ? redacted : redacted.slice(0, MAX_STRING);
  return value.length <= MAX_STRING ? bounded : `${bounded}…[truncated]`;
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
    out[key] = isSecretKey(key)
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

export function parseResponseMessage(message, { requestId, allowed }) {
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
  if (!allowed.includes(parsed.decision)) return null;

  if (parsed.decision === 'refine') {
    if (typeof parsed.text !== 'string') return null;
    const text = parsed.text.trim();
    if (!text) return null;
    return { decision: 'refine', text: text.slice(0, MAX_RESPONSE_TEXT) };
  }

  return { decision: parsed.decision };
}

export function parseDecisionMessage(message, { requestId, allowed }) {
  return parseResponseMessage(message, { requestId, allowed })?.decision ?? null;
}
