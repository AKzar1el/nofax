import { initConfig, loadConfig } from './config.mjs';
import { requestApproval, requestRefinement, sendNotification } from './ntfy.mjs';
import { handleClaudePermissionRequest } from './adapters/claude.mjs';
import { handleCodexPermissionRequest } from './adapters/codex.mjs';
import { handleGeminiNotification } from './adapters/gemini.mjs';

const HELP = `nofax - remote approvals and notifications for coding agents\n\nUsage:\n  nofax init [--server URL] [--topic TOPIC] [--timeout SECONDS] [--force]\n  nofax test\n  nofax notify [--title TITLE] MESSAGE...\n  nofax approve [--title TITLE] MESSAGE...\n  nofax refine [--title TITLE] MESSAGE...\n  nofax mcp\n  nofax config\n  nofax hook claude\n  nofax hook codex\n  nofax hook gemini\n\nEnvironment:\n  NOFAX_HOME   Override ~/.nofax\n`;

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--force') {
      flags.force = true;
      continue;
    }
    if (['--title', '--server', '--topic', '--timeout'].includes(value)) {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`NOFAX_FLAG_VALUE:${value}`);
      flags[value.slice(2)] = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--')) throw new Error(`NOFAX_UNKNOWN_FLAG:${value}`);
    positionals.push(value);
  }
  return { flags, positionals };
}

async function readStdin(stdinText) {
  if (stdinText !== undefined) return stdinText;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function runHook(adapter, deps) {
  const inputText = await readStdin(deps.stdinText);
  let input;
  try {
    input = JSON.parse(inputText);
  } catch {
    throw new Error('NOFAX_HOOK_INVALID_JSON');
  }
  const config = await deps.loadConfigImpl({ env: deps.env });
  const onError = (error) => deps.stderr.write(`nofax: ${error.message}\n`);
  let output;
  if (adapter === 'claude') {
    output = await handleClaudePermissionRequest(input, { config, requestApprovalImpl: deps.requestApprovalImpl, onError });
  } else if (adapter === 'codex') {
    output = await handleCodexPermissionRequest(input, { config, requestApprovalImpl: deps.requestApprovalImpl, onError });
  } else if (adapter === 'gemini') {
    output = await handleGeminiNotification(input, { config, sendNotificationImpl: deps.sendNotificationImpl });
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

    const command = args[0];
    if (command === 'init') {
      const { flags } = parseArgs(args.slice(1));
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
      const config = await deps.loadConfigImpl({ env: deps.env });
      deps.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    }

    if (command === 'test') {
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
      const { flags, positionals } = parseArgs(args.slice(1));
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
      const { flags, positionals } = parseArgs(args.slice(1));
      if (positionals.length === 0) throw new Error('NOFAX_MESSAGE_REQUIRED');
      const config = await deps.loadConfigImpl({ env: deps.env });
      const result = await deps.requestApprovalImpl({
        config,
        title: flags.title ?? 'Nofax approval',
        message: positionals.join(' ')
      });
      writeJson(deps.stdout, { decision: result.decision });
      return result.decision === 'timeout' ? 3 : 0;
    }

    if (command === 'refine') {
      const { flags, positionals } = parseArgs(args.slice(1));
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
      await deps.runMcpServerImpl();
      return 0;
    }

    if (command === 'hook') {
      const adapter = args[1];
      if (!adapter) throw new Error('NOFAX_HOOK_REQUIRED');
      return runHook(adapter, deps);
    }

    throw new Error(`NOFAX_UNKNOWN_COMMAND:${command}`);
  } catch (error) {
    deps.stderr.write(`nofax: ${error.message}\n`);
    return 1;
  }
}
