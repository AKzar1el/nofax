import { randomBytes } from 'node:crypto';

const SECRET_KEY = /(?:^|[_-])(token|password|passwd|secret|api[_-]?key|authorization|cookie|session[_-]?(?:id|key)|credential|private[_-]?key)(?:$|[_-])/i;
const MAX_STRING = 500;
const MAX_REDACTION_INPUT = 16 * 1024;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_SUMMARY = 2200;
const MAX_RESPONSE_TEXT = 2000;
const TRUNCATION_MARKER = '…[truncated]';

function normalizeSecretKeyName(key) {
  let normalized = '';

  // Invisible format marks and blank fillers can split a credential field
  // name without changing its appearance. Ignore them only for classification.
  const comparisonKey = key.normalize('NFKC')
    .replace(/\x1b\[[0-9;]{0,16}m/gu, '')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe0e-\ufe0f\ufeff\uffa0]/gu, '');

  for (let index = 0; index < comparisonKey.length; index += 1) {
    const char = comparisonKey[index];
    const code = char.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;

    if (!isUpper && !isLower && !isDigit) {
      if (normalized && !normalized.endsWith('_')) normalized += '_';
      continue;
    }

    const previousCode = index > 0 ? comparisonKey.charCodeAt(index - 1) : -1;
    const nextCode = index + 1 < comparisonKey.length ? comparisonKey.charCodeAt(index + 1) : -1;
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
  const isAuthHeaderValue = lower === 'auth_header_value'
    || lower.endsWith('_auth_header_value')
    || lower === 'auth_header_values'
    || lower.endsWith('_auth_header_values');
  const isPassphrase = lower === 'passphrase'
    || lower === 'pass_phrase'
    || lower.endsWith('_passphrase')
    || lower.endsWith('_pass_phrase');
  const isSignedUrlSignature = lower === 'sig' || lower === 'x_amz_signature' || lower === 'x_goog_signature';
  // Hosted Git PAT fields are credentials even when the key omits "token".
  const isHostedPat = /(?:^|_)(?:github|gitlab|gh)_pat$/.test(lower);
  return lower === 'auth' || isSignedUrlSignature || isAuthHeader || isAuthHeaderValue || isPassphrase || isHostedPat || SECRET_KEY.test(normalized);
}

function normalizeUnicodeEscapedSecretKeys(text) {
  // Serialized agent commands can conceal credential field names with JSON
  // Unicode escapes (including extra escaping when JSON is serialized again).
  // Normalize only secret-key names, so the existing quoted-value redaction
  // handles them without decoding or exposing unrelated command content.
  return text.replace(
    /(?<!\\)(\\*["'])((?:[A-Za-z0-9_./ \\-]|\\+u[0-9a-fA-F]{4}){1,64})\1(?=\s*[:=])/g,
    (match, quote, key) => {
      if (!key.includes('\\u')) return match;
      const decoded = key.replace(/\\+u([0-9a-fA-F]{4})/g, (_escape, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      return isSecretKey(decoded) ? `${quote}${decoded}${quote}` : match;
    }
  );
}

function redactControlInterruptedSecretKeyText(text) {
  // Inspect only bounded approval text; keep the original key spelling visible.
  if (!/[\x00\x1b]|\\u00(?:00|1b)/i.test(text)) return text;
  let plain = text;
  let wrappers = 0;
  while (wrappers < 3 && plain.startsWith('"') && plain.endsWith('"')) {
    let decoded;
    try { decoded = JSON.parse(plain); } catch { break; }
    if (typeof decoded !== 'string') break;
    plain = decoded;
    wrappers += 1;
  }

  const hasControl = /[\x00\x1b]/u;
  let changed = false;
  const objectStart = plain.indexOf('{');
  const arrayStart = /^\s*\[/u.test(plain) ? plain.indexOf('[') : -1;
  const jsonStart = objectStart !== -1 ? objectStart : arrayStart;
  const jsonEnd = jsonStart === -1 ? -1 : plain.lastIndexOf(jsonStart === arrayStart ? ']' : '}');
  if (jsonEnd > jsonStart && jsonStart !== -1) {
    let parsed;
    try { parsed = JSON.parse(plain.slice(jsonStart, jsonEnd + 1)); } catch { /* Not a complete JSON segment. */ }
    if (parsed && typeof parsed === 'object') {
      const pending = [parsed];
      while (pending.length > 0) {
        const node = pending.pop();
        for (const [key, child] of Object.entries(node)) {
          if (hasControl.test(key) && isSecretKey(key)) {
            node[key] = '[REDACTED]';
            changed = true;
          } else if (child && typeof child === 'object') {
            pending.push(child);
          }
        }
      }
      if (changed) plain = `${plain.slice(0, jsonStart)}${JSON.stringify(parsed)}${plain.slice(jsonEnd + 1)}`;
    }
  }

  if (!changed) {
    plain = plain.replace(
      /(?<![A-Za-z0-9_])(["']?)([A-Za-z](?:[A-Za-z0-9_.\/ -]|\x00|\x1b\[[0-9;]{0,16}m){0,96})\1([ \t]*[:=][ \t]*)(?:(["'])(?:\\.|(?!\4)[^\r\n])*\4|[^\s"'`,;&}\]]+)/gu,
      (match, quote, key, separator) => {
        if (!hasControl.test(key) || !isSecretKey(key)) return match;
        changed = true;
        return `${quote}${key}${quote}${separator}[REDACTED]`;
      }
    );
  }
  if (!changed) {
    // A malformed embedded JSON segment cannot be parsed safely. Suppress the
    // entire preview only when an encoded or raw control hides a secret key.
    const unresolvedKeys = /([A-Za-z](?:[A-Za-z0-9_.\/ -]|\x00|\x1b\[[0-9;]{0,16}m|\\+u001b\[[0-9;]{0,16}m|\\+u0000){0,96})(?:\\*["'])?[ \t]*[:=]/giu;
    for (const match of plain.matchAll(unresolvedKeys)) {
      const decoded = match[1].replace(/\\+u001b\[[0-9;]{0,16}m|\\+u0000/giu, '');
      if (decoded !== match[1] && isSecretKey(decoded)) return '[CONTROL_KEY_INPUT_REDACTED]';
    }
  }
  if (!changed) return text;
  for (let index = 0; index < wrappers; index += 1) plain = JSON.stringify(plain);
  return plain;
}

function redactInvisibleSecretKeyText(text) {
  const invisible = /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe0e-\ufe0f\ufeff\uffa0]/u;
  if (!invisible.test(text)) return text;

  // Classify the original key before escaping its invisible marks for display.
  // Preserve that evidence while hiding the value in quoted and plain assignments.
  return text.replace(
    /(["']?)([A-Za-z][A-Za-z0-9_.\/ \-\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe0e-\ufe0f\ufeff\uffa0]{0,63})\1([ \t]*[:=][ \t]*)(?:(?:bearer|basic)[ \t]+(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s`,;&}\]]+)|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s`,;&}\]]+)/giu,
    (match, keyQuote, key, separator) => {
      if (!invisible.test(key) || !isSecretKey(key)) return match;
      const prefix = `${keyQuote}${key}${keyQuote}${separator}`;
      const value = match.slice(prefix.length);
      const valueQuote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${prefix}${valueQuote}[REDACTED]${valueQuote}`;
    }
  );
}

function redactCompatibilitySecretKeyText(text) {
  if (!/[^\x00-\x7f]/u.test(text)) return text;
  const isCompatibilitySecret = (key) => key.normalize('NFKC') !== key && isSecretKey(key);

  // Keep the original suspicious spelling visible while redacting its value.
  // Quoted keys/values may also be nested in once- or twice-serialized JSON.
  let redacted = text.replace(
    /(?<![\p{L}\p{N}\p{Pc}])(\\*["'])([\p{L}\p{N}\p{Pc}_.\/ \-]{1,64})\1([ \t]*[:=][ \t]*)(\\*["'])(?:\\.|(?!(?<!\\)\4)[^\r\n])*?(?<!\\)\4/gu,
    (match, keyQuote, key, separator, valueQuote) => isCompatibilitySecret(key)
      ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );
  redacted = redacted.replace(
    /(?<![\p{L}\p{N}\p{Pc}])(\\*["']?)([\p{L}\p{N}\p{Pc}_.\/ \-]{1,64})\1([ \t]*[:=][ \t]*)(?!\\*["'])([^\s"'\x60,;&}\]]+)/gu,
    (match, keyQuote, key, separator) => isCompatibilitySecret(key)
      ? `${keyQuote}${key}${keyQuote}${separator}[REDACTED]`
      : match
  );
  return redacted;
}

function redactYamlCredentialAliases(text) {
  // Approval previews can contain YAML directly or inside nested JSON strings.
  // Split only line separators, retaining their original escaping for display.
  const parts = text.split(/(\r\n|\n|(?:\\{1,4}r)?\\{1,4}n)/g);
  const credentialAnchors = new Set();
  for (let index = 0; index < parts.length; index += 2) {
    // A YAML flow mapping may put credential aliases after '{' or ',' on
    // the same line; serialization can escape its optional key quotes.
    for (const alias of parts[index].matchAll(/(?:^|[,{])\s*(?:-\s*)?((?:\\{0,4})["'])?([A-Za-z][A-Za-z0-9_. -]{0,63})\1\s*:\s*\*([A-Za-z0-9_-]{1,64})(?=\s|$|\\|["',}\]])/g)) {
      if (isSecretKey(alias[2])) credentialAnchors.add(alias[3]);
    }
  }
  if (credentialAnchors.size === 0) return text;

  let blockIndent = null;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const indent = line.match(/^[ \t]*/)[0].length;
    if (blockIndent !== null && line.trim() && indent <= blockIndent) blockIndent = null;
    if (blockIndent !== null && indent > blockIndent) {
      if (line.trim()) parts[index] = `${line.slice(0, indent)}[REDACTED]`;
      continue;
    }

    const anchors = /(^|[ \t:=])&([A-Za-z0-9_-]{1,64})(?=\s|$|\\|["'])/g;
    for (const match of line.matchAll(anchors)) {
      if (!credentialAnchors.has(match[2])) continue;
      const end = match.index + match[0].length;
      const tail = line.slice(end);
      const isBlock = /^\s*(?:[|>][-+0-9]*)?\s*$/.test(tail);
      parts[index] = `${line.slice(0, end)} [REDACTED]`;
      if (isBlock) blockIndent = indent;
      break;
    }
  }
  return parts.join('');
}

function redactShellCredentialBlocks(text) {
  // Decode only whole JSON-string wrappers, not arbitrary shell expressions.
  let plain = text;
  let wrappers = 0;
  while (wrappers < 3 && plain.startsWith('"') && plain.endsWith('"')) {
    let decoded;
    try { decoded = JSON.parse(plain); } catch { break; }
    if (typeof decoded !== 'string') break;
    plain = decoded;
    wrappers += 1;
  }

  const headers = /^([ \t]*(?:export[ \t]+)?(?:\$env:|\$)?)([A-Za-z][A-Za-z0-9_]{0,63})([ \t]*=[ \t]*)(?:\$\([ \t]*cat[ \t]+<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]{0,31})\5[^\r\n]*|@(["']))(?=\r?$)/gm;
  let output = '';
  let cursor = 0;
  let changed = false;
  for (const match of plain.matchAll(headers)) {
    if (match.index < cursor || !isSecretKey(match[2])) continue;
    const headerEnd = match.index + match[0].length;
    const firstBreak = plain.indexOf('\n', headerEnd);
    if (firstBreak === -1) continue;

    let nextStart = firstBreak + 1;
    let blockEnd = plain.length;
    while (nextStart <= plain.length) {
      const lineEnd = plain.indexOf('\n', nextStart);
      const afterLine = lineEnd === -1 ? plain.length : lineEnd + 1;
      const line = plain.slice(nextStart, lineEnd === -1 ? undefined : lineEnd).replace(/\r$/, '');
      const openingIndent = match[1].match(/^[ \t]*/)[0];
      const psClosing = match[7] + '@';
      const isTerminator = match[7]
        ? line === psClosing || (openingIndent.length > 0 && line === openingIndent + psClosing)
        : (match[4] === '-' ? line.replace(/^\t+/, '') : line) === match[6];
      if (isTerminator) {
        blockEnd = afterLine;
        break;
      }
      if (lineEnd === -1) break;
      nextStart = afterLine;
    }

    output += plain.slice(cursor, match.index);
    // Quoting the placeholder keeps later assignment matchers from swallowing
    // escaped newlines and the safe fields after a serialized credential block.
    output += match[1] + match[2] + match[3] + '"[REDACTED]"';
    if (blockEnd < plain.length) output += '\n';
    changed = true;
    cursor = blockEnd;
    if (blockEnd === plain.length) break; // An unterminated secret has no safe boundary.
  }
  if (!changed) return text;
  output += plain.slice(cursor);
  for (let index = 0; index < wrappers; index += 1) output = JSON.stringify(output);
  return output;
}

function redactMultilineCredentialAssignments(text) {
  // Only standalone JSON-string wrappers are decoded, so quoted line breaks
  // can be recognized without reinterpreting arbitrary command text.
  let plain = text;
  let wrappers = 0;
  while (wrappers < 3 && plain.startsWith('"') && plain.endsWith('"')) {
    let decoded;
    try { decoded = JSON.parse(plain); } catch { break; }
    if (typeof decoded !== 'string') break;
    plain = decoded;
    wrappers += 1;
  }

  const assignments = /^([ \t]*(?:export[ \t]+)?)([A-Za-z][A-Za-z0-9_. -]{0,63})([ \t]*=[ \t]*)("""|'''|"|')/gm;
  let cursor = 0;
  let output = '';
  let changed = false;
  for (const match of plain.matchAll(assignments)) {
    if (match.index < cursor || !isSecretKey(match[2])) continue;
    const quote = match[4];
    const valueStart = match.index + match[0].length;
    let closing = -1;
    let searchFrom = valueStart;
    while (searchFrom < plain.length) {
      const candidate = plain.indexOf(quote, searchFrom);
      if (candidate === -1) break;
      let backslashes = 0;
      if (quote[0] === '"') {
        for (let index = candidate - 1; index >= valueStart && plain[index] === '\\'; index -= 1) backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        closing = candidate;
        break;
      }
      searchFrom = candidate + 1;
    }

    const body = plain.slice(valueStart, closing === -1 ? undefined : closing);
    if (!/[\r\n]/.test(body)) continue;
    output += plain.slice(cursor, match.index);
    output += `${match[1]}${match[2]}${match[3]}${quote}[REDACTED]${quote}`;
    changed = true;
    cursor = closing === -1 ? plain.length : closing + quote.length;
    if (closing === -1) break; // An unterminated secret has no safe sibling boundary.
  }
  if (!changed) return text;
  output += plain.slice(cursor);
  for (let index = 0; index < wrappers; index += 1) output = JSON.stringify(output);
  return output;
}

function redactSecretText(value) {
  // Whole JSON-string previews may encode line breaks as backslash-n. Decode
  // only those complete wrappers so key-value matchers cannot eat a safe
  // sibling across an escaped line boundary; preserve the original nesting.
  let wrappers = 0;
  while (wrappers < 3 && value.startsWith('"') && value.endsWith('"')) {
    let decoded;
    try { decoded = JSON.parse(value); } catch { break; }
    if (typeof decoded !== 'string') break;
    value = decoded;
    wrappers += 1;
  }
  let redacted = redactCompatibilitySecretKeyText(
    redactInvisibleSecretKeyText(normalizeUnicodeEscapedSecretKeys(redactYamlCredentialAliases(redactMultilineCredentialAssignments(redactShellCredentialBlocks(redactControlInterruptedSecretKeyText(value))))))
  );

  redacted = redacted.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
    (_match, label) => `-----BEGIN ${label}-----\n[REDACTED]\n-----END ${label}-----`
  );

  redacted = redacted.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/)([^\s\/?#"'`<>]+)/g,
    (match, scheme, authority) => {
      const finalAt = authority.lastIndexOf('@');
      if (finalAt === -1) return match;

      const userinfo = authority.slice(0, finalAt);
      const host = authority.slice(finalAt + 1);
      const passwordAt = userinfo.indexOf(':');
      // Keep established username:password output, but never expose token-only
      // or ambiguous multi-@ userinfo in approval previews.
      if (passwordAt !== -1 && !userinfo.includes('@')) {
        return `${scheme}${userinfo.slice(0, passwordAt)}:[REDACTED]@${host}`;
      }
      return `${scheme}[REDACTED]@${host}`;
    }
  );

  // Commands may embed a JSON string containing another serialized JSON object,
  // such as \"api_key\":\"value\". Redact escaped credential fields too.
  redacted = redacted.replace(
    /(?<!\\)(\\+")([A-Za-z][A-Za-z0-9_./ \\-\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe0e-\ufe0f\ufeff\uffa0]{0,63})\1(\s*[:=]\s*)\1[\s\S]*?(?<!\\)\1/g,
    (match, quote, key, separator) => isSecretKey(key)
      ? quote + key + quote + separator + quote + '[REDACTED]' + quote
      : match
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
    /(^|[\r\n]|[({\[,:;])([ \t]*)(["'])((?:proxy[-_])?authorization)\3(\s*[:=]\s*)[^}\])\r\n]*(?=[}\])]|$)/gim,
    '$1$2$3$4$3$5[REDACTED]'
  );

  redacted = redacted.replace(
    /([({\[,:;][ \t]*)((?:proxy[-_])?authorization)(\s*[:=]\s*)(?!\[REDACTED\]|(?:bearer|basic)\b)[^}\])\r\n]*(?=[}\])]|$)/gi,
    '$1$2$3[REDACTED]'
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
    /([?&#])((?:[A-Za-z]|%[0-9a-fA-F]{2})(?:[A-Za-z0-9._+-]|%[0-9a-fA-F]{2}){0,63})=([^&\s"'`,;]+)/g,
    (match, prefix, key) => {
      let decodedKey;
      // Form-encoded query keys interpret '+' as a space (e.g. api+key).
      try { decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { return match; }
      return isSecretKey(decodedKey) || decodedKey.toLowerCase() === 'signature'
        ? `${prefix}${key}=[REDACTED]`
        : match;
    }
  );

  redacted = redacted.replace(
    /(["'])([A-Za-z][A-Za-z0-9_./ \\-]{0,63})\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4)[^\r\n])*\4/g,
    (match, keyQuote, key, separator, valueQuote) => isSecretKey(key)
      ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );

  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9_./-]{0,63}(?:[ \t]+[A-Za-z][A-Za-z0-9_./-]{0,63})?)(\s*[:=]\s*)(["'])(.*?)\3/g,
    (match, key, separator, valueQuote) => isSecretKey(key)
      ? `${key}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );

  // Preserve the displayed auth scheme, but never leave its credential behind.
  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9_./-]{0,63}(?:[ \t]+[A-Za-z][A-Za-z0-9_./-]{0,63})?)([ \t]*[:=][ \t]*)(bearer|basic)([ \t]+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'`,;&]+)/gi,
    (match, key, separator, scheme, gap) => isSecretKey(key)
      ? `${key}${separator}${scheme}${gap}[REDACTED]`
      : match
  );

  redacted = redacted.replace(
    /([A-Za-z][A-Za-z0-9_./-]{0,63}(?:[ \t]+[A-Za-z][A-Za-z0-9_./-]{0,63})?)(\s*[:=]\s*)([^\s"'`,;&]+)/g,
    (match, key, separator, rawValue) => {
      if (!isSecretKey(key)) return match;
      if (/^\[REDACTED\][}\])]*$/.test(rawValue)) return match;
      if (/authorization$/i.test(normalizeSecretKeyName(key)) && /^(?:bearer|basic)$/i.test(rawValue)) return match;
      return `${key}${separator}[REDACTED]`;
    }
  );

  redacted = redacted.replace(
    /(^|\s)(-u|--user|--proxy-user)(\s+|=)(["'])([^:\r\n"']*):([^\r\n"']+)\4/g,
    (_match, prefix, flag, separator, quote, username) => (
      `${prefix}${flag}${separator}${quote}${username}:[REDACTED]${quote}`
    )
  );

  redacted = redacted.replace(
    /(^|\s)(-u|--user|--proxy-user)(\s+|=)([^:\s"';&|]*):([^\s"';&|]+)/g,
    (_match, prefix, flag, separator, username) => (
      `${prefix}${flag}${separator}${username}:[REDACTED]`
    )
  );

  redacted = redacted.replace(
    /--([A-Za-z][A-Za-z0-9_./-]{0,63})(\s+)(["'](?:.*?)["']|[^\s"'`,;&]+)/g,
    (match, key, separator) => isSecretKey(key)
      ? `--${key}${separator}[REDACTED]`
      : match
  );

  redacted = redacted.replace(
    /(^|[^A-Za-z0-9_-])(["']?)((?:proxy[-_])?authorization)\2([ \t]*[:=][ \t]*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)+/gim,
    (match, prefix, quote, key, separator) => {
      const trailingDelimiters = match.match(/[}\])]+$/)?.[0] ?? '';
      return `${prefix}${quote}${key}${quote}${separator}[REDACTED]${trailingDelimiters}`;
    }
  );

  for (let index = 0; index < wrappers; index += 1) redacted = JSON.stringify(redacted);
  return redacted;
}

export function redactDiagnosticSecrets(value) {
  // Error strings can originate outside NoFax and reach captured stderr.
  // Never show a prefix of oversized input that might contain a partial token.
  if (value.length > MAX_REDACTION_INPUT) return '[OVERSIZED_INPUT_REDACTED]...[truncated]';
  return redactSecretText(value);
}

function randomBase64Url(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function safeSliceEnd(text, end) {
  const previous = text.charCodeAt(end - 1);
  return previous >= 0xD800 && previous <= 0xDBFF ? end - 1 : end;
}

function escapeDisplayControls(text) {
  // Human-facing summaries must reveal hidden direction and zero-width marks,
  // while retaining ordinary line breaks and emoji joiners.
  const characters = [...text];
  return characters.map((character, index) => {
    if (character === '\u200c' || character === '\u200d') {
      let before = index - 1;
      while (before >= 0 && /[\ufe0e\ufe0f\p{Emoji_Modifier}]/u.test(characters[before])) before--;
      if (character === '\u200d' &&
          /\p{Extended_Pictographic}/u.test(characters[before] ?? '') &&
          /\p{Extended_Pictographic}/u.test(characters[index + 1] ?? '')) {
        return character;
      }
      return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`;
    }
    return character.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f-\u1160\u180e\u200b\u200e-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u2800\u3164\uffa0\ufeff]/gu,
      (control) => `\\u${control.codePointAt(0).toString(16).padStart(4, '0')}`);
  }).join('');
}

function boundResponseText(value) {
  if (value.length <= MAX_RESPONSE_TEXT) return value;
  const end = safeSliceEnd(value, MAX_RESPONSE_TEXT - TRUNCATION_MARKER.length);
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
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
  // Do not run complex credential-redaction patterns on arbitrarily large
  // untrusted commands. Showing a prefix could disclose a partial secret.
  if (value.length > MAX_REDACTION_INPUT) return '[OVERSIZED_INPUT_REDACTED]';
  const redacted = escapeDisplayControls(redactSecretText(value));
  const truncated = value.length > MAX_STRING || redacted.length > MAX_STRING;
  const bounded = redacted.length <= MAX_STRING
    ? redacted
    : redacted.slice(0, safeSliceEnd(redacted, MAX_STRING));
  return truncated ? `${bounded}${TRUNCATION_MARKER}` : bounded;
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
  // Track only the active recursion path; shared sibling references are not cycles.
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && isSecretKey(value[0])) {
      seen.delete(value);
      return [boundString(value[0]), '[REDACTED]'];
    }
    const bounded = value.slice(0, MAX_ARRAY);
    const pairedLength = bounded.length - (bounded.length % 2);
    const out = bounded.map((item, index) => (
      index < pairedLength
      && index % 2 === 1
      && typeof bounded[index - 1] === 'string'
      && isSecretKey(bounded[index - 1])
        ? '[REDACTED]'
        : redactAndBound(item, { seen, depth: depth + 1 })
    ));
    if (value.length > MAX_ARRAY) out.push(TRUNCATION_MARKER);
    seen.delete(value);
    return out;
  }

  const entries = Object.entries(value);
  const redactEntryValue = entries.some(([key, child]) => (
    typeof child === 'string'
    && (key.toLowerCase() === 'name' || key.toLowerCase() === 'key' || key.toLowerCase() === 'header')
    && isSecretKey(child)
  ));

  const out = {};
  for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const normalizedKey = key.toLowerCase();
    const bounded = isSecretKey(key) || (redactEntryValue && (normalizedKey === 'value' || normalizedKey === 'values'))
      ? '[REDACTED]'
      : redactAndBound(child, { seen, depth: depth + 1 });
    // Assignment to '__proto__' changes the prototype instead of retaining approval context.
    Object.defineProperty(out, key, { value: bounded, enumerable: true, writable: true, configurable: true });
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    let markerKey = TRUNCATION_MARKER;
    while (Object.hasOwn(out, markerKey)) markerKey += '*';
    out[markerKey] = true;
  }
  seen.delete(value);
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
  const end = safeSliceEnd(serialized, 1400);
  return `${serialized.slice(0, end)}\n${TRUNCATION_MARKER}`;
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
  const end = safeSliceEnd(result, MAX_SUMMARY - 14);
  return `${result.slice(0, end)}\n${TRUNCATION_MARKER}`;
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
  const decision = parsed.decision.trim();
  if (!decision || !allowed.includes(decision)) return null;

  if (decision === 'refine') {
    if (kind === 'choice') return { decision: 'refine' };
    if (typeof parsed.text !== 'string') return null;
    const text = parsed.text.trim();
    // JSON permits escaped lone surrogates; never silently rewrite a human refinement.
    if (!text || !text.isWellFormed()) return null;
    return { decision: 'refine', text: boundResponseText(text) };
  }

  return { decision };
}

export function parseDecisionMessage(message, { requestId, allowed, kind }) {
  return parseResponseMessage(message, { requestId, allowed, kind })?.decision ?? null;
}
