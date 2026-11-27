import { readFile } from 'node:fs/promises';
import { initConfig, isLegacyRepeatedTopic, loadConfig } from './config.mjs';
import { requestApproval, requestRefinement, sendNotification } from './ntfy.mjs';
import { listPendingRequests } from './requests.mjs';
import { handleClaudePermissionRequest } from './adapters/claude.mjs';
import { handleCodexPermissionRequest } from './adapters/codex.mjs';
import { handleGeminiHook } from './adapters/gemini.mjs';
import { redactDiagnosticSecrets } from './protocol.mjs';

const HELP = `nofax - remote approvals and notifications for coding agents\n\nUsage:\n  nofax --version\n  nofax init [--server URL] [--topic TOPIC] [--timeout SECONDS] [--force]\n  nofax doctor\n  nofax test\n  nofax pending [--limit N]\n  nofax notify [--title TITLE] MESSAGE...\n  nofax approve [--title TITLE] MESSAGE...\n  nofax refine [--title TITLE] MESSAGE...\n  nofax mcp\n  nofax config [--show-topic]\n  nofax hook claude\n  nofax hook codex\n  nofax hook gemini\n\nEnvironment:\n  NOFAX_HOME   Override ~/.nofax\n`;

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);
const MAX_HOOK_STDIN_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 4096;
const DIAGNOSTIC_TRUNCATION = '...[truncated]';
const DOCTOR_EXPLICIT_SERVER_ERRORS = new Set([
  'NOFAX_CONFIG_VERSION', 'NOFAX_CONFIG_INVALID_JSON', 'NOFAX_CONFIG_INVALID_UTF8',
  'NOFAX_CONFIG_TOO_LARGE', 'NOFAX_SERVER_INVALID', 'NOFAX_SERVER_PROTOCOL',
  'NOFAX_SERVER_CREDENTIALS', 'NOFAX_SERVER_PATH', 'NOFAX_SERVER_INSECURE_HTTP'
]);
const DOCTOR_CONFIG_ERRORS = new Set([
  ...DOCTOR_EXPLICIT_SERVER_ERRORS, 'NOFAX_TOPIC_INVALID', 'NOFAX_TIMEOUT_INVALID', 'NOFAX_HOME_EMPTY'
]);
const DIAGNOSTIC_CONTROLS = /[\x00-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f-\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

function safeDiagnostic(error) {
  // Untrusted transport errors may contain line controls or invisible marks
  // that disguise decision words or flood logs after escape expansion.
  const chunks = [];
  let length = 0;
  for (const character of redactDiagnosticSecrets(String(error?.message ?? error))) {
    const point = character.codePointAt(0);
    const rendered = DIAGNOSTIC_CONTROLS.test(character)
      ? (point <= 0xffff ? '\\u' + point.toString(16).padStart(4, '0') : '\\u{' + point.toString(16) + '}')
      : character;
    if (length + rendered.length > MAX_DIAGNOSTIC_CHARS) {
      // Back off whole escaped characters; never split a Unicode pair or escape.
      while (length > MAX_DIAGNOSTIC_CHARS - DIAGNOSTIC_TRUNCATION.length) {
        length -= chunks.pop().length;
      }
      return chunks.join('') + DIAGNOSTIC_TRUNCATION;
    }
    chunks.push(rendered);
    length += rendered.length;
  }
  return chunks.join('');
}

async function readPackageVersion() {
  const metadata = JSON.parse(await readFile(PACKAGE_JSON_URL, 'utf8'));
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error('NOFAX_PACKAGE_VERSION_INVALID');
  }
  return metadata.version;
}

function parseArgs(args, allowedFlags = []) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (value === '--force') {
      if (!allowedFlags.includes(value)) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
      flags.force = true;
      continue;
    }
    if (value === '--show-topic') {
      if (!allowedFlags.includes(value)) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
      flags.showTopic = true;
      continue;
    }
    if (['--title', '--server', '--topic', '--timeout', '--limit'].includes(value)) {
      if (!allowedFlags.includes(value)) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
      const key = value.slice(2);
      if (Object.hasOwn(flags, key)) throw new Error(`NOFAX_DUPLICATE_FLAG:${value}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`NOFAX_FLAG_VALUE:${value}`);
      flags[key] = next;
      index += 1;
      continue;
    }
    // Unknown arguments may carry credentials (--token=...), so do not echo
    // their caller-controlled text into logs or captured approval output.
    if (value.startsWith('--')) throw new Error('NOFAX_UNKNOWN_FLAG');
    positionals.push(value);
  }
  return { flags, positionals };
}

function rejectUnexpectedArgs(positionals) {
  if (positionals.length > 0) throw new Error('NOFAX_UNEXPECTED_ARGUMENT');
}

async function readStdin(stdinText, stdinStream = process.stdin) {
  if (stdinText !== undefined) {
    if (Buffer.byteLength(stdinText, 'utf8') > MAX_HOOK_STDIN_BYTES) {
      throw new Error('NOFAX_HOOK_INPUT_TOO_LARGE');
    }
    // Match stream validation: malformed JavaScript text must never be
    // normalized before a human sees the command requiring approval.
    if (typeof stdinText === 'string' && !stdinText.isWellFormed()) {
      throw new Error('NOFAX_HOOK_INVALID_UTF8');
    }
    return stdinText;
  }

  const chunks = [];
  let totalBytes = 0;
  let pendingHighSurrogate = '';
  const append = (bytes) => {
    totalBytes += bytes.length;
    if (totalBytes > MAX_HOOK_STDIN_BYTES) {
      throw new Error('NOFAX_HOOK_INPUT_TOO_LARGE');
    }
    chunks.push(bytes);
  };
  for await (const chunk of stdinStream) {
    if (typeof chunk === 'string') {
      // A custom text stream may split a UTF-16 surrogate pair between yields.
      // Encode the pair together rather than replacing each half with U+FFFD.
      const text = pendingHighSurrogate + chunk;
      const last = text.charCodeAt(text.length - 1);
      const hasHighSurrogate = last >= 0xD800 && last <= 0xDBFF;
      pendingHighSurrogate = hasHighSurrogate ? text.slice(-1) : '';
      const completeText = hasHighSurrogate ? text.slice(0, -1) : text;
      if (!completeText.isWellFormed()) throw new Error('NOFAX_HOOK_INVALID_UTF8');
      append(Buffer.from(completeText));
    } else {
      if (pendingHighSurrogate) {
        throw new Error('NOFAX_HOOK_INVALID_UTF8');
      }
      append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  if (pendingHighSurrogate) throw new Error('NOFAX_HOOK_INVALID_UTF8');
  try {
    // Replacement characters would make the command shown for human approval
    // differ from the bytes supplied by the hook. Reject malformed input.
    // Preserve the previous BOM behavior: JSON.parse must reject a leading BOM.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(chunks, totalBytes));
  } catch {
    throw new Error('NOFAX_HOOK_INVALID_UTF8');
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function runHook(adapter, deps) {
  const inputText = await readStdin(deps.stdinText, deps.stdinStream);
  let input;
  try {
    input = JSON.parse(inputText);
  } catch {
    throw new Error('NOFAX_HOOK_INVALID_JSON');
  }
  const onError = (error) => deps.stderr.write(`nofax: ${safeDiagnostic(error)}\n`);
  let config;
  try {
    config = await deps.loadConfigImpl({ env: deps.env });
  } catch (error) {
    if (adapter === 'gemini' && input.hook_event_name === 'Notification') {
      onError(error);
      writeJson(deps.stdout, {});
      return 0;
    }
    throw error;
  }
  let output;
  if (adapter === 'claude') {
    output = await handleClaudePermissionRequest(input, { config, requestApprovalImpl: deps.requestApprovalImpl, onError });
  } else if (adapter === 'codex') {
    output = await handleCodexPermissionRequest(input, { config, requestApprovalImpl: deps.requestApprovalImpl, onError });
  } else if (adapter === 'gemini') {
    output = await handleGeminiHook(input, {
      config,
      requestApprovalImpl: deps.requestApprovalImpl,
      sendNotificationImpl: deps.sendNotificationImpl,
      onError
    });
  } else {
    throw new Error('NOFAX_HOOK_UNSUPPORTED');
  }

  if (output === null) {
    deps.stderr.write('nofax: no remote decision; continuing with native approval.\n');
    return 0;
  }
  writeJson(deps.stdout, output);
  return 0;
}

export async function runCli(args, overrides = {}) {
  const deps = {
    env: overrides.env ?? process.env,
    stdinText: overrides.stdinText,
    stdinStream: overrides.stdinStream ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    initConfigImpl: overrides.initConfigImpl ?? initConfig,
    loadConfigImpl: overrides.loadConfigImpl ?? loadConfig,
    requestApprovalImpl: overrides.requestApprovalImpl ?? requestApproval,
    requestRefinementImpl: overrides.requestRefinementImpl ?? requestRefinement,
    sendNotificationImpl: overrides.sendNotificationImpl ?? sendNotification,
    listPendingRequestsImpl: overrides.listPendingRequestsImpl ?? listPendingRequests,
    runMcpServerImpl: overrides.runMcpServerImpl ?? (async () => {
      const { runMcpServer } = await import('./mcp-server.mjs');
      await runMcpServer();
    })
  };
  const rawLoadConfig = deps.loadConfigImpl;
  deps.loadConfigImpl = async (...options) => {
    const config = await rawLoadConfig(...options);
    // Do not let old guessable topics reach notification or approval handlers.
    if (isLegacyRepeatedTopic(config?.topic)) {
      throw new Error('NOFAX_LEGACY_TOPIC_ROTATION_REQUIRED: run nofax init --force');
    }
    return config;
  };

  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      if (args.length > 0) {
        const { positionals } = parseArgs(args.slice(1));
        rejectUnexpectedArgs(positionals);
      }
      deps.stdout.write(HELP);
      return 0;
    }

    if (args[0] === '--version' || args[0] === '-v') {
      const { positionals } = parseArgs(args.slice(1));
      rejectUnexpectedArgs(positionals);
      deps.stdout.write(`${await readPackageVersion()}\n`);
      return 0;
    }

    const command = args[0];
    if (command === 'init') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--server', '--topic', '--timeout', '--force']);
      rejectUnexpectedArgs(positionals);
      const timeoutSeconds = flags.timeout === undefined ? undefined : Number(flags.timeout);
      let created = false;
      const config = await deps.initConfigImpl({
        env: deps.env,
        ...(flags.server === undefined ? {} : { server: flags.server }),
        ...(flags.topic === undefined ? {} : { topic: flags.topic }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        force: flags.force === true,
        rejectExisting: flags.force !== true &&
          (flags.server !== undefined || flags.topic !== undefined || flags.timeout !== undefined),
        onCreated: () => { created = true; }
      });
      if (isLegacyRepeatedTopic(config?.topic)) {
        throw new Error('NOFAX_LEGACY_TOPIC_ROTATION_REQUIRED: run nofax init --force');
      }
      if (created) {
        deps.stdout.write('Nofax ready.\n');
        deps.stdout.write(`Subscribe your ntfy app to: ${config.server}/${config.topic}\n`);
        deps.stdout.write('Then run: nofax test\n');
      } else {
        deps.stdout.write('Nofax ready (already initialized).\n');
        deps.stdout.write('To view your existing subscription topic, run nofax config --show-topic privately.\n');
      }
      return 0;
    }

    if (command === 'config') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--show-topic']);
      rejectUnexpectedArgs(positionals);
      const config = await rawLoadConfig({ env: deps.env });
      if (isLegacyRepeatedTopic(config?.topic)) {
        deps.stderr.write('nofax: legacy topic requires rotation; run nofax init --force.\n');
        deps.stdout.write(`${JSON.stringify({ ...config, topic: '[ROTATION_REQUIRED]' }, null, 2)}\n`);
      } else {
        deps.stdout.write(`${JSON.stringify(flags.showTopic ? config : { ...config, topic: '[REDACTED]' }, null, 2)}\n`);
      }
      return 0;
    }

    if (command === 'doctor') {
      rejectUnexpectedArgs(args.slice(1));
      let localConfig;
      let nextStep;
      let errorCode;
      try {
        const config = await rawLoadConfig({ env: deps.env });
        localConfig = isLegacyRepeatedTopic(config.topic) ? 'legacy_topic' : 'valid';
        nextStep = localConfig === 'valid' ? 'nofax test' : 'nofax init --force';
      } catch (error) {
        localConfig = error?.message === 'NOFAX_NOT_INITIALIZED' ? 'not_initialized' : 'invalid';
        nextStep = localConfig === 'not_initialized' ? 'nofax init' : 'review local configuration';
        if (localConfig === 'invalid') {
          // Never echo untrusted filesystem errors, paths, or credential contents.
          errorCode = DOCTOR_CONFIG_ERRORS.has(error?.message)
            ? error.message : 'NOFAX_CONFIG_UNAVAILABLE';
          if (DOCTOR_EXPLICIT_SERVER_ERRORS.has(errorCode)) {
            nextStep = 'review local configuration; if replacing, use nofax init --force --server URL';
          }
        }
      }
      writeJson(deps.stdout, {
        localConfig,
        ...(errorCode === undefined ? {} : { errorCode }),
        notificationDelivery: 'not_tested',
        humanApproval: 'not_tested',
        nextStep
      });
      return localConfig === 'valid' ? 0 : 1;
    }

    if (command === 'pending') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--limit']);
      rejectUnexpectedArgs(positionals);
      const limit = flags.limit === undefined ? 20 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('NOFAX_REQUEST_LIMIT_INVALID');
      }
      const requests = await deps.listPendingRequestsImpl({ env: deps.env, limit });
      // Local diagnostics expose request metadata only, never prompts or decisions.
      deps.stdout.write(`${JSON.stringify({ requests: requests.map(({ requestId, kind, status, createdAt }) => ({
        requestId, kind, status, createdAt
      })) })}\n`);
      return 0;
    }
    if (command === 'test') {
      rejectUnexpectedArgs(args.slice(1));
      const config = await deps.loadConfigImpl({ env: deps.env });
      await deps.sendNotificationImpl({
        config,
        title: 'Nofax is connected',
        message: 'If you can read this on your phone, Nofax is ready.'
      });
      deps.stdout.write('Test notification sent.\n');
      return 0;
    }

    if (command === 'notify') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--title']);
      if (positionals.length === 0) throw new Error('NOFAX_MESSAGE_REQUIRED');
      const config = await deps.loadConfigImpl({ env: deps.env });
      await deps.sendNotificationImpl({
        config,
        title: flags.title ?? 'Nofax',
        message: positionals.join(' ')
      });
      deps.stdout.write('Notification sent.\n');
      return 0;
    }

    if (command === 'approve') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--title']);
      if (positionals.length === 0) throw new Error('NOFAX_MESSAGE_REQUIRED');
      const config = await deps.loadConfigImpl({ env: deps.env });
      const result = await deps.requestApprovalImpl({
        config,
        title: flags.title ?? 'Nofax approval',
        message: positionals.join(' ')
      });
      writeJson(deps.stdout, { decision: result.decision });
      // Shell callers must not mistake a denied or invalid decision for approval.
      if (result.decision === 'allow') return 0;
      if (result.decision === 'deny') return 2;
      return result.decision === 'timeout' ? 3 : 1;
    }

    if (command === 'refine') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--title']);
      if (positionals.length === 0) throw new Error('NOFAX_MESSAGE_REQUIRED');
      const config = await deps.loadConfigImpl({ env: deps.env });
      const result = await deps.requestRefinementImpl({
        config,
        title: flags.title ?? 'Nofax refinement',
        message: positionals.join(' ')
      });
      writeJson(deps.stdout, {
        decision: result.decision,
        ...(result.text === undefined ? {} : { text: result.text })
      });
      // A zero exit code must mean an actual, nonempty human refinement.
      if (result.decision === 'refine') {
        return typeof result.text === 'string' && result.text.trim() ? 0 : 1;
      }
      if (result.decision === 'deny') return 2;
      return result.decision === 'timeout' ? 3 : 1;
    }

    if (command === 'mcp') {
      rejectUnexpectedArgs(args.slice(1));
      await deps.runMcpServerImpl();
      return 0;
    }

    if (command === 'hook') {
      const adapter = args[1];
      if (!adapter) throw new Error('NOFAX_HOOK_REQUIRED');
      rejectUnexpectedArgs(args.slice(2));
      try {
        return await runHook(adapter, deps);
      } catch (error) {
        if (adapter === 'gemini') {
          deps.stderr.write(`nofax: ${safeDiagnostic(error)}\n`);
          writeJson(deps.stdout, { decision: 'ask' });
          return 0;
        }
        if (adapter === 'claude' || adapter === 'codex') {
          deps.stderr.write(`nofax: ${safeDiagnostic(error)}\n`);
          deps.stderr.write('nofax: no remote decision; continuing with native approval.\n');
          return 0;
        }
        throw error;
      }
    }

    throw new Error('NOFAX_UNKNOWN_COMMAND');
  } catch (error) {
    deps.stderr.write(`nofax: ${safeDiagnostic(error)}\n`);
    return 1;
  }
}
