import { readFile } from 'node:fs/promises';
import { initConfig, loadConfig } from './config.mjs';
import { requestApproval, requestRefinement, sendNotification } from './ntfy.mjs';
import { handleClaudePermissionRequest } from './adapters/claude.mjs';
import { handleCodexPermissionRequest } from './adapters/codex.mjs';
import { handleGeminiHook } from './adapters/gemini.mjs';

const HELP = `nofax - remote approvals and notifications for coding agents\n\nUsage:\n  nofax --version\n  nofax init [--server URL] [--topic TOPIC] [--timeout SECONDS] [--force]\n  nofax test\n  nofax notify [--title TITLE] MESSAGE...\n  nofax approve [--title TITLE] MESSAGE...\n  nofax refine [--title TITLE] MESSAGE...\n  nofax mcp\n  nofax config\n  nofax hook claude\n  nofax hook codex\n  nofax hook gemini\n\nEnvironment:\n  NOFAX_HOME   Override ~/.nofax\n`;

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);
const MAX_HOOK_STDIN_BYTES = 1024 * 1024;

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
    if (value === '--force') {
      if (!allowedFlags.includes(value)) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
      flags.force = true;
      continue;
    }
    if (['--title', '--server', '--topic', '--timeout'].includes(value)) {
      if (!allowedFlags.includes(value)) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`NOFAX_FLAG_VALUE:${value}`);
      flags[value.slice(2)] = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
    positionals.push(value);
  }
  return { flags, positionals };
}

function rejectUnexpectedArgs(positionals) {
  if (positionals.length > 0) throw new Error(`NOFAX_UNEXPECTED_ARGUMENT:${positionals[0]}`);
}

async function readStdin(stdinText, stdinStream = process.stdin) {
  if (stdinText !== undefined) {
    if (Buffer.byteLength(stdinText, 'utf8') > MAX_HOOK_STDIN_BYTES) {
      throw new Error('NOFAX_HOOK_INPUT_TOO_LARGE');
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
      append(Buffer.from(hasHighSurrogate ? text.slice(0, -1) : text));
    } else {
      if (pendingHighSurrogate) {
        append(Buffer.from(pendingHighSurrogate));
        pendingHighSurrogate = '';
      }
      append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  if (pendingHighSurrogate) append(Buffer.from(pendingHighSurrogate));
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
  const onError = (error) => deps.stderr.write(`nofax: ${error.message}\n`);
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
    throw new Error(`NOFAX_HOOK_UNSUPPORTED:${adapter}`);
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
    runMcpServerImpl: overrides.runMcpServerImpl ?? (async () => {
      const { runMcpServer } = await import('./mcp-server.mjs');
      await runMcpServer();
    })
  };

  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      deps.stdout.write(HELP);
      return 0;
    }

    if (args[0] === '--version' || args[0] === '-v') {
      deps.stdout.write(`${await readPackageVersion()}\n`);
      return 0;
    }

    const command = args[0];
    if (command === 'init') {
      const { flags, positionals } = parseArgs(args.slice(1), ['--server', '--topic', '--timeout', '--force']);
      rejectUnexpectedArgs(positionals);
      const timeoutSeconds = flags.timeout === undefined ? undefined : Number(flags.timeout);
      const config = await deps.initConfigImpl({
        env: deps.env,
        ...(flags.server === undefined ? {} : { server: flags.server }),
        ...(flags.topic === undefined ? {} : { topic: flags.topic }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        force: flags.force === true
      });
      deps.stdout.write('Nofax ready.\n');
      deps.stdout.write(`Subscribe your ntfy app to: ${config.server}/${config.topic}\n`);
      deps.stdout.write('Then run: nofax test\n');
      return 0;
    }

    if (command === 'config') {
      rejectUnexpectedArgs(args.slice(1));
      const config = await deps.loadConfigImpl({ env: deps.env });
      deps.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
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
      return result.decision === 'timeout' ? 3 : 0;
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
          deps.stderr.write(`nofax: ${error.message}\n`);
          writeJson(deps.stdout, { decision: 'ask' });
          return 0;
        }
        if (adapter === 'claude' || adapter === 'codex') {
          deps.stderr.write(`nofax: ${error.message}\n`);
          deps.stderr.write('nofax: no remote decision; continuing with native approval.\n');
          return 0;
        }
        throw error;
      }
    }

    throw new Error(`NOFAX_UNKNOWN_COMMAND:${command}`);
  } catch (error) {
    deps.stderr.write(`nofax: ${error.message}\n`);
    return 1;
  }
}
