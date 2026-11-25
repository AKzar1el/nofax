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
  // Unicode space separators can make an otherwise recognizable key look benign.
  let redacted = text.replace(
    /(?<![\p{L}\p{N}\p{Pc}])(\\*["'])([\p{L}\p{N}\p{Pc}_.\/ \-\p{Zs}]{1,64})\1([ \t]*[:=][ \t]*)(\\*["'])(?:\\.|(?!(?<!\\)\4)[^\r\n])*?(?<!\\)\4/gu,
    (match, keyQuote, key, separator, valueQuote) => isCompatibilitySecret(key)
      ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );
  redacted = redacted.replace(
    /(?<![\p{L}\p{N}\p{Pc}])([\p{L}\p{N}\p{Pc}_.\/ \-\p{Zs}]{1,64})([ \t]*[:=][ \t]*)(\\*["'])(?:\\.|(?!(?<!\\)\3)[^\r\n])*?(?<!\\)\3/gu,
    (match, key, separator, valueQuote) => isCompatibilitySecret(key)
      ? `${key}${separator}${valueQuote}[REDACTED]${valueQuote}`
      : match
  );
  redacted = redacted.replace(
    /(?<![\p{L}\p{N}\p{Pc}])(\\*["']?)([\p{L}\p{N}\p{Pc}_.\/ \-\p{Zs}]{1,64})\1([ \t]*[:=][ \t]*)(?!\\*["'])([^\s"'\x60,;&}\]]+)/gu,
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

function redactShellExpressionCredentials(text) {
  // Shell words can concatenate quotes and substitutions after an assignment.
  // Mask the entire bounded word before simpler key=value redactors split it.
  const assignments = /(^|[\s;])((?:export[ \t]+)?(?:\$env:|\$)?)([A-Za-z][A-Za-z0-9_]{0,63})([ \t]*=[ \t]*)/gm;
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(assignments)) {
    if (match.index < cursor || !isSecretKey(match[3])) continue;
    const valueStart = match.index + match[0].length;
    const frames = [];
    let special = false;
    let index = valueStart;

    while (index < text.length) {
      const char = text[index];
      const frame = frames[frames.length - 1];
      if (frame === 'single') {
        if (char === "'") frames.pop();
        index += 1;
        continue;
      }
      if (char === '\\') {
        if (!frame) special = true;
        index = Math.min(text.length, index + 2);
        continue;
      }
      if (frame === 'double') {
        if (char === '"') frames.pop();
        else if (char === '$' && text[index + 1] === '(') {
          frames.push('sub');
          index += 2;
          special = true;
          continue;
        } else if (char === '`') frames.push('backtick');
        index += 1;
        continue;
      }
      if (frame === 'backtick' && char === '`') {
        frames.pop();
        index += 1;
        continue;
      }
      if (frame === 'sub' && char === ')') {
        frames.pop();
        index += 1;
        continue;
      }
      if (char === '$' && text[index + 1] === '(') {
        frames.push('sub');
        special = true;
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        frames.push(char === "'" ? 'single' : char === '"' ? 'double' : 'backtick');
        if (!frame && (index > valueStart || char === '`')) special = true;
        index += 1;
        continue;
      }
      if (frame === 'sub' && char === '(') {
        frames.push('sub');
        index += 1;
        continue;
      }
      if (!frame && /[\s,;&|}\]]/.test(char)) break;
      index += 1;
    }

    if (!special) continue;
    // An unterminated expression has no trustworthy trailing-word boundary.
    if (frames.length > 0) index = text.length;
    output += text.slice(cursor, match.index) + match[0] + '[REDACTED]';
    cursor = index;
  }
  return output + text.slice(cursor);
}

// Split only at unquoted, top-level delimiters. An incomplete quote or group
// deliberately consumes the remainder instead of guessing where a secret ends.
function splitPowerShellPreview(text, delimiter) {
  const parts = [];
  const groups = [];
  let quote = '';
  let hereQuote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (hereQuote) {
      if (text[index - 1] === '\n' && char === hereQuote && text[index + 1] === '@') {
        hereQuote = '';
        index += 1;
      }
      continue;
    }
    if (char === '\x60' && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (text[index + 1] === quote) index += 1;
        else quote = '';
      }
      continue;
    }
    if (char === '@' && /["']/.test(text[index + 1] ?? '')
        && (text[index + 2] === '\n' || text.slice(index + 2, index + 4) === '\r\n')) {
      hereQuote = text[index + 1];
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ('([{'.includes(char)) groups.push(char);
    else if (')]}'.includes(char) && groups.at(-1) === '([{'.charAt(')]}'.indexOf(char))) groups.pop();
    if (!groups.length && delimiter.test(char)) {
      parts.push({ text: text.slice(start, index), delimiter: char });
      start = index + 1;
    }
  }
  parts.push({ text: text.slice(start), delimiter: '' });
  return parts;
}

function powerShellLiteral(word) {
  if (!word) return '';
  const quote = word[0];
  if ((quote === '"' || quote === "'") && word.endsWith(quote)) {
    return word.slice(1, -1).replace(quote === "'" ? /''/g : /""/g, quote);
  }
  return word;
}

function redactPowerShellCredentialCommands(text, depth = 0) {
  if (!/\b(?:Set-Item|New-Item|Set-Content|Set-Variable)\b/i.test(text)) return text;
  // Inspect string lexemes in complete serialized containers without
  // rebuilding objects (which could discard duplicate keys or context).
  if (depth < 3 && /^\s*[\[{" ]/.test(text)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* Not a complete JSON value. */ }
    if (typeof parsed === 'string') {
      const masked = redactPowerShellCredentialCommands(parsed, depth + 1);
      return masked === parsed ? text : JSON.stringify(masked);
    }
    if (parsed && typeof parsed === 'object') {
      return text.replace(/"(?:\\.|[^"\\])*"/g, lexeme => {
        const decoded = JSON.parse(lexeme);
        const masked = redactPowerShellCredentialCommands(decoded, depth + 1);
        return masked === decoded ? lexeme : JSON.stringify(masked);
      });
    }
  }
  return splitPowerShellPreview(text, /[;|\r\n&]/).map(({ text: segment, delimiter }) => {
    const command = /^([ \t]*)((?:Microsoft\.PowerShell\.(?:Management|Utility)\\)?(Set-Item|New-Item|Set-Content|Set-Variable))(?=[ \t])/i.exec(segment);
    if (!command) return segment + delimiter;
    const variable = command[3].toLowerCase() === 'set-variable';
    const args = splitPowerShellPreview(segment.slice(command[0].length), /[ \t]/)
      .map(part => part.text).filter(Boolean);
    const names = [];
    const paths = [];
    const positional = [];
    let ambiguous = false;
    const switches = /^(?:force|whatif|confirm|verbose|debug|passthru|nonewline|asbytestream)$/i;
    const otherValues = /^(?:value|scope|option|description|erroraction|warningaction|informationaction|errorvariable|warningvariable|informationvariable|outvariable|outbuffer|pipelinevariable|credential|filter|include|exclude|encoding|stream|itemtype|type)$/i;
    for (let index = 0; index < args.length; index += 1) {
      const option = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(args[index]);
      if (!option) {
        positional.push(args[index]);
        continue;
      }
      const [, name, attached] = option;
      if (switches.test(name)) continue;
      const isName = /^name$/i.test(name);
      const isPath = /^(?:path|literalpath)$/i.test(name);
      if (!isName && !isPath && !otherValues.test(name)) {
        ambiguous = true;
        continue;
      }
      const arg = attached ?? args[++index];
      if (!arg) ambiguous = true;
      else if (isName) names.push(arg);
      else if (isPath) paths.push(arg);
    }
    const targets = variable ? names : paths;
    if (!targets.length && positional.length) targets.push(positional[0]);
    const literalName = /^[\p{L}\p{N}_.:/\\-]+$/u;
    const sensitiveName = word => {
      const value = powerShellLiteral(word);
      return !literalName.test(value) || isSecretKey(value);
    };
    const sensitivePath = word => {
      const value = powerShellLiteral(word);
      const provider = /^(?:(?:Microsoft\.PowerShell\.Core\\)?(?:environment|variable)::|(?:env|variable):)\\?([\s\S]*)$/i.exec(value);
      if (!provider) {
        // A composed provider expression has no trustworthy literal target.
        return /(?:env|variable|environment):/i.test(value)
          && /[()[\]{},$\x60]/.test(value);
      }
      return provider[1] ? sensitiveName(provider[1]) : names.some(sensitiveName);
    };
    const sensitive = variable
      ? targets.some(sensitiveName)
      : targets.some(sensitivePath);
    // For unknown option layouts, avoid assuming that a credential-like
    // positional argument is harmless. For recognized sensitive operations,
    // omit the arguments rather than attempting to evaluate shell expressions.
    const uncertain = ambiguous && args.some(word => {
      const attached = /^-[A-Za-z]+:([\s\S]+)$/.exec(word)?.[1];
      return variable
        ? isSecretKey(powerShellLiteral(attached ?? word))
        : sensitivePath(attached ?? word);
    });
    return sensitive || uncertain
      ? command[1] + command[2] + ' [REDACTED: credential command arguments]' + delimiter
      : segment + delimiter;
  }).join('');
}

function isSetxExecutable(value) {
  return typeof value === 'string' && /(?:^|[\\/])setx(?:\.exe)?$/i.test(value.replace(/^"|"$/g, ''));
}

function redactSetxArgv(argv) {
  if (!isSetxExecutable(argv[0])) return argv;
  if (argv.length === 1 || (argv.length === 2 && argv[1] === '/?')) return argv;

  // Only the literal local variable/value form has an unambiguous value
  // position. Omit all arguments for other layouts (including remote options).
  const local = (argv.length === 3 || (argv.length === 4 && typeof argv[3] === 'string' && /^\/m$/i.test(argv[3])))
    && typeof argv[1] === 'string' && /^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(argv[1])
    && typeof argv[2] === 'string';
  if (!local) return [argv[0], '[REDACTED: credential command arguments]'];
  return isSecretKey(argv[1]) ? [argv[0], argv[1], '[REDACTED]', ...argv.slice(3)] : argv;
}

function powerShellProviderCommand(value) {
  if (typeof value !== 'string') return null;
  return /^(?:Microsoft\.PowerShell\.(?:Management|Utility)\\)?(Set-Item|New-Item|Set-Content|Set-Variable)$/i.exec(powerShellLiteral(value))?.[1].toLowerCase() ?? null;
}

function redactPowerShellProviderArgv(argv) {
  const command = powerShellProviderCommand(argv[0]);
  if (!command || argv.length === 1) return argv;
  const omitted = () => [argv[0], '[REDACTED: credential command arguments]'];
  const variable = command === 'set-variable';
  const names = [];
  const paths = [];
  const positional = [];
  let hasValue = false;
  const switches = /^(?:force|whatif|confirm|verbose|debug|passthru|nonewline|asbytestream)$/i;
  const otherValues = /^(?:scope|option|description|erroraction|warningaction|informationaction|errorvariable|warningvariable|informationvariable|outvariable|outbuffer|pipelinevariable|filter|include|exclude|encoding|stream|itemtype|type)$/i;

  // Inspect typed argument boundaries directly; joining them into shell text
  // would reinterpret literal whitespace, punctuation and nested values.
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (typeof word !== 'string') return omitted();
    const option = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(word);
    if (!option) {
      if (word.startsWith('-')) return omitted();
      positional.push(word);
      continue;
    }
    const [, flag, attached] = option;
    if (switches.test(flag)) {
      if (attached !== undefined && !/^\$(?:true|false)$/i.test(attached)) return omitted();
      continue;
    }
    const isName = /^name$/i.test(flag);
    const isPath = /^(?:path|literalpath)$/i.test(flag);
    const isValue = /^value$/i.test(flag);
    if (!isName && !isPath && !isValue && !otherValues.test(flag)) return omitted();
    const arg = attached ?? argv[++index];
    if (typeof arg !== 'string' || (attached === undefined && arg.startsWith('-'))) return omitted();
    if (isName) names.push(arg);
    else if (isPath) paths.push(arg);
    else if (isValue) {
      if (hasValue) return omitted();
      hasValue = true;
    }
  }

  const targets = variable ? names : paths;
  if (variable && paths.length) return omitted();
  if (!targets.length && positional.length) targets.push(positional.shift());
  if (targets.length !== 1 || positional.length > (hasValue ? 0 : 1)) return omitted();
  const literalName = /^[\p{L}\p{N}_.:/\\-]+$/u;
  const sensitiveName = word => {
    const name = powerShellLiteral(word);
    return !literalName.test(name) || isSecretKey(name);
  };
  if (variable) return sensitiveName(targets[0]) ? omitted() : argv;

  const path = powerShellLiteral(targets[0]);
  const provider = /^(?:(?:Microsoft\.PowerShell\.Core\\)?(?:environment|variable)::|(?:env|variable):)\\?([\s\S]*)$/i.exec(path);
  if (provider) {
    if (!provider[1]) {
      if (names.length !== 1 || sensitiveName(names[0])) return omitted();
    } else if (names.length || sensitiveName(provider[1])) return omitted();
  } else if (/[()[\]{},$\x60*?]/.test(path) || !path || names.length) {
    // A composed or unresolved target cannot establish a benign provider.
    return omitted();
  }
  return argv;
}

function interpreterArgvKind(value) {
  if (typeof value !== 'string') return null;
  const exe = value.replace(/^"|"$/g, '').split(/[\\/]/).pop();
  if (/^(?:python(?:\d+(?:\.\d+)?)?w?|pyw?)(?:\.exe)?$/i.test(exe)) return 'python';
  if (/^node(?:js)?(?:\.exe)?$/i.test(exe)) return 'node';
  return null;
}

function interpreterCodeMayExposeCredentials(code, kind) {
  if (code.length > MAX_REDACTION_INPUT) return true;
  // Lexical classification only: never evaluate code or resolve runtime aliases.
  // Keep literal benign targets, but omit ambiguous environment access.
  const tokens = [];
  const lexer = kind === 'python'
    ? /#[^\r\n]*|(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")|\\\r?\n|[\p{L}_][\p{L}\p{N}_]*|[^\s]/gu
    : /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\x60(?:\\[\s\S]|[^\x60\\])*\x60|[\p{L}_$][\p{L}\p{N}_$]*|[^\s]/gu;
  for (const match of code.matchAll(lexer)) {
    const token = match[0];
    if (kind === 'python' ? token.startsWith('#') || /^\\\r?\n$/.test(token) : token.startsWith('//') || token.startsWith('/*')) continue;
    tokens.push(token);
  }
  // A slash outside a recognized comment/string can begin a JS regex literal.
  // Its contents can mimic a comment and conceal subsequent environment access.
  if (kind === 'node' && tokens.includes('/') && /\b(?:process|env)\b/.test(code)) return true;
  if (kind === 'node' && tokens.some(token => /^(?:require|import|globalThis)$/.test(token))
      && tokens.some(token => token === 'env' || /^(['"])env\1$/.test(token))
      && !tokens.includes('process')) return true;
  const literal = token => {
    if (!token || !/^(['"])[A-Za-z_][A-Za-z0-9_.-]*\1$/.test(token)) return null;
    return token.slice(1, -1);
  };
  const benign = name => name !== null && !isSecretKey(name);
  const bracketKey = index => tokens[index] === '[' && tokens[index + 2] === ']' && benign(literal(tokens[index + 1]));
  const callKey = index => tokens[index] === '(' && [',', ')'].includes(tokens[index + 2]) && benign(literal(tokens[index + 1]));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    // Interpolated strings and escaped identifiers are not plain literals.
    if (kind === 'node' && token.startsWith('\x60') && token.includes('$' + '{') && /process|env|\\u/.test(token)) return true;
    if (kind === 'python' && /^(?:f|fr|rf)$/i.test(previous ?? '') && /^['"]/.test(token) && token.includes('{') && /environ|putenv|getattr|os/.test(token)) return true;
    if (token === '\\') return true;
    if (kind === 'python') {
      if (/^(?:environ|environb)$/.test(token)) {
        if (previous !== '.') return true;
        if (bracketKey(i + 1)) continue;
        if (next === '.' && /^(?:get|setdefault|pop)$/.test(tokens[i + 2] ?? '') && callKey(i + 3)) continue;
        return true;
      }
      if (/^(?:putenv|unsetenv|getenv|getenvb)$/.test(token)) {
        if (previous === '.' && callKey(i + 1)) continue;
        return true;
      }
      if (/^(?:getattr|setattr|__import__)$/.test(token) && tokens.includes('os')) return true;
      if (/^(['"])(?:os|environ|environb|putenv)\1$/.test(token) && (previous === '[' || previous === ',' || previous === '(') && tokens.some(t => /^(?:getattr|setattr|__import__|import_module)$/.test(t))) return true;
    } else {
      if (/^(['"])(?:node:)?process\1$/.test(token) && (previous === '[' || previous === 'from' || previous === 'import' || (previous === '(' && tokens[i - 2] === 'require'))) return true;
      if (token !== 'process') continue;
      let end;
      if (next === '.' && tokens[i + 2] === 'env') end = i + 3;
      else if (next === '[' && literal(tokens[i + 2]) === 'env' && tokens[i + 3] === ']') end = i + 4;
      else if (next === '.' && /^[A-Za-z_$][\w$]*$/.test(tokens[i + 2] ?? '')) continue;
      else return true;
      if (bracketKey(end)) continue;
      if (tokens[end] === '.' && /^[A-Za-z_$][\w$]*$/.test(tokens[end + 1] ?? '') && benign(tokens[end + 1])) continue;
      return true;
    }
  }
  return false;
}

function redactInterpreterArgv(argv) {
  const kind = interpreterArgvKind(argv[0]);
  if (!kind) return argv;
  const omitted = () => [argv[0], '[REDACTED: credential command arguments]'];
  let ambiguousOption = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') return omitted();
    if (arg === '--') break;
    if (!arg.startsWith('-')) {
      // An unclassified option may consume a separate argument. Do not
      // assume this positional-looking token is the script boundary.
      if (!ambiguousOption) break;
      continue;
    }
    if (kind === 'python' && /^-[bBdEiIOPqRsSuvVx]*m/.test(arg)) break;
    if (kind === 'node' && /^--run(?:=|$)/.test(arg)) break;
    const optionWithValue = kind === 'python'
      ? /^(?:-[bBdEiIOPqRsSuvVx]*[WX]|--check-hash-based-pycs)$/
      : /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--experimental-policy|--env-file|--env-file-if-exists|--icu-data-dir|--openssl-config|--title|--watch-path|--redirect-warnings|--diagnostic-dir|--report-directory|--report-filename|--snapshot-blob|--heapsnapshot-signal|--inspect-port)$/;
    if (optionWithValue.test(arg)) {
      if (typeof argv[++i] !== 'string') return omitted();
      continue;
    }
    const match = (kind === 'python' ? /^-[bBdEiIOPqRsSuvVx]*c([\s\S]*)$/ : /^(?:-(?:pe|ep|ie|ip|e|p)([\s\S]*)|--(?:eval|print)(?:=([\s\S]*))?)$/).exec(arg);
    if (!match) {
      const knownStandalone = kind === 'python'
        ? /^(?:-[bBdEiIOPqRsSuvVx]+|-[WX].+|-[23](?:\.\d+)?|--help|--version)$/
        : /^(?:--no-warnings|--trace-warnings|--no-deprecation|--trace-deprecation|--enable-source-maps|--no-experimental-fetch|--experimental-repl-await|-i|--interactive|-v|--version|-h|--help)$/;
      if (!knownStandalone.test(arg) && !arg.includes('=')) ambiguousOption = true;
      continue;
    }
    const attached = match[1] || match[2];
    const code = attached || (arg.endsWith('=') ? '' : argv[++i]);
    if (typeof code !== 'string' || interpreterCodeMayExposeCredentials(code, kind)) return omitted();
    // Python's -c ends interpreter option processing; Node permits repeated
    // inline eval options until its own positional or -- boundary.
    if (kind === 'python') break;
    ambiguousOption = false;
  }
  return argv;
}

function redactCommandArgv(argv) {
  if (interpreterArgvKind(argv[0])) return redactInterpreterArgv(argv);
  return isSetxExecutable(argv[0]) ? redactSetxArgv(argv) : redactPowerShellProviderArgv(argv);
}

function isCredentialCommand(value) {
  return isSetxExecutable(value) || !!powerShellProviderCommand(value) || !!interpreterArgvKind(value);
}

const COMMAND_FIELD = /^(?:command|executable|program|file)$/i;
const ARGUMENT_FIELD = /^(?:args|arguments|argv)$/i;
const OMITTED_COMMAND_ARGS = '[REDACTED: credential command arguments]';
const COMMAND_PREVIEW_HINT = /setx|Set-Item|New-Item|Set-Content|Set-Variable|python|node|\bpyw?\b|\\u/i;

function looksLikeCredentialCommandCarrier(text, depth = 0) {
  // Malformed JSON cannot establish safe field boundaries. Recognize an
  // explicit executable field or first argv element without rebuilding it.
  if (depth >= MAX_DEPTH) return true;
  let previous = null;
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    try {
      const decoded = JSON.parse(match[0]);
      const start = match.index;
      if (isCredentialCommand(decoded)) {
        if (text.slice(0, start).trimEnd().endsWith('[')) return true;
        if (previous && COMMAND_FIELD.test(previous.value) && /^\s*:\s*$/.test(text.slice(previous.end, start))) return true;
      }
      if (/^\s*[\[{"]/.test(decoded) && COMMAND_PREVIEW_HINT.test(decoded)
          && looksLikeCredentialCommandCarrier(decoded, depth + 1)) return true;
      previous = { value: decoded, end: start + match[0].length };
    } catch { previous = null; }
  }
  return false;
}

function splitCommandMaskIndices(entries) {
  const commands = entries.filter(([key, value]) => COMMAND_FIELD.test(key) && isCredentialCommand(value));
  if (!commands.length) return new Set();
  const masked = new Set();
  for (const [index, [key, value]] of entries.entries()) {
    if (!ARGUMENT_FIELD.test(key)) continue;
    // Duplicate fields are possible in serialized input. A benign duplicate
    // must not override evidence that another command can expose credentials.
    if (!Array.isArray(value) || value.length > MAX_ARRAY || commands.length > MAX_OBJECT_KEYS
        || value.some(arg => typeof arg !== 'string')
        || commands.some(([, executable]) => {
          const argv = [executable, ...value];
          return redactCommandArgv(argv) !== argv;
        })) masked.add(index);
  }
  return masked;
}

function redactSerializedCommandArgv(text, depth = 0) {
  if (!/^\s*[\[{" ]/.test(text) || !COMMAND_PREVIEW_HINT.test(text)) return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return looksLikeCredentialCommandCarrier(text) ? OMITTED_COMMAND_ARGS : text;
  }
  if (depth >= MAX_DEPTH) return '[REDACTED: nested command preview]';
  if (typeof parsed === 'string') {
    const masked = redactSerializedCommandArgv(parsed, depth + 1);
    return masked === parsed ? text : JSON.stringify(masked);
  }
  if (!parsed || typeof parsed !== 'object') return text;

  // Inspect exact spans, not rebuilt objects: duplicate keys and unrelated
  // review context must remain intact. Associate fields only in their own frame.
  const frames = [];
  const replacements = [];
  function completeValue(start, end) {
    const parent = frames[frames.length - 1];
    if (parent?.kind !== '{' || parent.key === null) return;
    const key = parent.key;
    parent.key = null;
    if (COMMAND_FIELD.test(key) || ARGUMENT_FIELD.test(key)) {
      parent.entries.push([key, JSON.parse(text.slice(start, end))]);
      parent.spans.push({ start, end });
    }
  }
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (token === '[' || token === '{') {
      frames.push({ kind: token, start, key: null, entries: [], spans: [] });
    } else if (token === ']' || token === '}') {
      const frame = frames.pop();
      if (token === ']') {
        const first = /^\s*("(?:\\.|[^"\\])*")/.exec(text.slice(frame.start + 1, start));
        if (first && isCredentialCommand(JSON.parse(first[1]))) {
          const argv = JSON.parse(text.slice(frame.start, end));
          const masked = redactCommandArgv(argv);
          if (masked !== argv) replacements.push({ start: frame.start, end, value: JSON.stringify(masked) });
        }
      } else {
        for (const index of splitCommandMaskIndices(frame.entries)) {
          replacements.push({ ...frame.spans[index], value: JSON.stringify(OMITTED_COMMAND_ARGS) });
        }
      }
      completeValue(frame.start, end);
    } else if (token !== ':' && token !== ',') {
      if (token.startsWith('"')) {
        const decoded = JSON.parse(token);
        if (/^\s*:/.test(text.slice(end))) {
          frames[frames.length - 1].key = decoded;
          continue;
        }
        const masked = redactSerializedCommandArgv(decoded, depth + 1);
        if (masked !== decoded) replacements.push({ start, end, value: JSON.stringify(masked) });
      }
      completeValue(start, end);
    }
  }
  let result = '';
  let offset = 0;
  // An outer masked span takes precedence over replacements within it.
  replacements.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const replacement of replacements) {
    if (replacement.start < offset) continue;
    result += text.slice(offset, replacement.start) + replacement.value;
    offset = replacement.end;
  }
  return result + text.slice(offset);
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
  value = redactPowerShellCredentialCommands(redactSerializedCommandArgv(value, wrappers));
  let redacted = redactCompatibilitySecretKeyText(
    redactInvisibleSecretKeyText(normalizeUnicodeEscapedSecretKeys(redactYamlCredentialAliases(redactShellExpressionCredentials(redactMultilineCredentialAssignments(redactShellCredentialBlocks(redactControlInterruptedSecretKeyText(value)))))))
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
    const maskedArgv = redactCommandArgv(value);
    if (maskedArgv !== value) {
      seen.delete(value);
      return maskedArgv.map(boundString);
    }
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
  const maskedArgs = splitCommandMaskIndices(entries);
  const redactEntryValue = entries.some(([key, child]) => (
    typeof child === 'string'
    && (key.toLowerCase() === 'name' || key.toLowerCase() === 'key' || key.toLowerCase() === 'header')
    && isSecretKey(child)
  ));

  const out = {};
  for (const [index, [key, child]] of entries.slice(0, MAX_OBJECT_KEYS).entries()) {
    const normalizedKey = key.toLowerCase();
    const bounded = maskedArgs.has(index) ? OMITTED_COMMAND_ARGS
      : isSecretKey(key) || (redactEntryValue && (normalizedKey === 'value' || normalizedKey === 'values'))
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
