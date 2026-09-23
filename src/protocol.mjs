import { randomBytes } from 'node:crypto';

const SECRET_KEY = /(?:^|[_-])(token|password|passwd|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_SUMMARY = 2200;
const MAX_RESPONSE_TEXT = 2000;

function normalizeSecretKeyName(key) {
  let normalized = '';

  for (let index = 0; index < key.length; index += 1) {
    const char = key[index];
    const code = char.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;

    if (!isUpper && !isLower && !isDigit) {
      if (normalized && !normalized.endsWith('_')) normalized += '_';
      continue;
    }

    const previousCode = index > 0 ? key.charCodeAt(index - 1) : -1;
    const nextCode = index + 1 < key.length ? key.charCodeAt(index + 1) : -1;
    const previousIsUpper = previousCode >= 65 && previousCode <= 90;
    const previousIsLower = previousCode >= 97 && previousCode <= 122;
    const previousIsDigit = previousCode >= 48 && previousCode <= 57;
    const nextIsLower = nextCode >= 97 && nextCode <= 122;

    if (
      isUpper
      && normalized
      && !normalized.endsWith('_')
      && (previousIsLower || previousIsDigit || (previousIsUpper && nextIsLower))
    ) {
      normalized += '_';
    }

    normalized += char;
  }

  return normalized;
}

function isSecretKey(key) {
  const normalized = normalizeSecretKeyName(key);
  const lower = normalized.toLowerCase();
  const isAuthHeader = lower === 'auth_header' || lower.endsWith('_auth_header');
  const isPassphrase = lower === 'passphrase'
    || lower === 'pass_phrase'
    || lower.endsWith('_passphrase')
    || lower.endsWith('_pass_phrase');
  return lower === 'auth' || isAuthHeader || isPassphrase || SECRET_KEY.test(normalized);
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
    /([^ \t\r\n=][ \t]+|=)((?:proxy[-_])?authorization)(\s*[:=]\s*)(?!\[REDACTED\]|(?:bearer|basic)\b)[^\r\n]*/gi,
    '$1$2$3[REDACTED]'
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
    if (value.length === 2 && typeof value[0] === 'string' && isSecretKey(value[0])) {
      return [boundString(value[0]), '[REDACTED]'];
    }
    const bounded = value.slice(0, MAX_ARRAY);
    const pairedLength = bounded.length - (bounded.length % 2);
    return bounded.map((item, index) => (
      index < pairedLength
      && index % 2 === 1
      && typeof bounded[index - 1] === 'string'
      && isSecretKey(bounded[index - 1])
        ? '[REDACTED]'
        : redactAndBound(item, { seen, depth: depth + 1 })
    ));
  }

  const entryName = Object.entries(value).find(([key, child]) => (
    typeof child === 'string'
    && (key.toLowerCase() === 'name' || key.toLowerCase() === 'key' || key.toLowerCase() === 'header')
  ))?.[1] ?? null;
  const redactEntryValue = entryName !== null && isSecretKey(entryName);

  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const normalizedKey = key.toLowerCase();
    out[key] = isSecretKey(key) || (redactEntryValue && (normalizedKey === 'value' || normalizedKey === 'values'))
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

export function parseResponseMessage(message, { requestId, allowed, kind }) {
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
    if (kind === 'choice') return { decision: 'refine' };
    if (typeof parsed.text !== 'string') return null;
    const text = parsed.text.trim();
    if (!text) return null;
    return { decision: 'refine', text: text.slice(0, MAX_RESPONSE_TEXT) };
  }

  return { decision: parsed.decision };
}

export function parseDecisionMessage(message, { requestId, allowed, kind }) {
  return parseResponseMessage(message, { requestId, allowed, kind })?.decision ?? null;
}
