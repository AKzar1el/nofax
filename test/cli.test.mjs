import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';

function capture() {
  let text = '';
  return { write: (chunk) => { text += String(chunk); }, read: () => text };
}

test('init creates config and prints a subscription URL', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['init'], { env: { NOFAX_HOME: home }, stdout, stderr });
  assert.equal(code, 0);
  const config = await loadConfig({ home });
  assert.match(stdout.read(), new RegExp(`https://ntfy.sh/${config.topic}`));
  assert.equal(stderr.read(), '');
});

test('generic approve prints stable machine-readable JSON', async () => {
  const stdout = capture();
  const stderr = capture();
  const config = { version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 };
  const code = await runCli(['approve', '--title', 'Deploy?', 'Ship', 'release'], {
    stdout,
    stderr,
    loadConfigImpl: async () => config,
    requestApprovalImpl: async ({ title, message }) => {
      assert.equal(title, 'Deploy?');
      assert.equal(message, 'Ship release');
      return { decision: 'allow' };
    }
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), '{"decision":"allow"}\n');
  assert.equal(stderr.read(), '');
});

test('Claude hook stdout contains only native hook JSON', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' }
  });
  const code = await runCli(['hook', 'claude'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
    requestApprovalImpl: async () => ({ decision: 'deny' })
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Denied remotely via Nofax.' }
    }
  });
  assert.equal(stderr.read(), '');
});

test('hook timeout writes no stdout so native approval can continue', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' }
  });
  const code = await runCli(['hook', 'codex'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
    requestApprovalImpl: async () => ({ decision: 'timeout' })
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /native approval/i);
});

test('Claude and Codex hook setup failures cleanly fall back to native approval', async () => {
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' }
  });

  for (const adapter of ['claude', 'codex']) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['hook', adapter], {
      stdinText: input,
      stdout,
      stderr,
      loadConfigImpl: async () => { throw new Error('NOFAX_CONFIG_MISSING'); }
    });
    assert.equal(code, 0);
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), /NOFAX_CONFIG_MISSING/);
    assert.match(stderr.read(), /native approval/i);
  }
});
test('Gemini Notification setup failure stays advisory with valid empty JSON', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'Approval needed'
  });
  const code = await runCli(['hook', 'gemini'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => { throw new Error('NOFAX_CONFIG_MISSING'); }
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), {});
  assert.match(stderr.read(), /NOFAX_CONFIG_MISSING/);
});
test('Gemini BeforeTool hook emits only strict decision JSON', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'BeforeTool', cwd: '/repo', tool_name: 'run_shell_command', tool_input: { command: 'npm test' }
  });
  const code = await runCli(['hook', 'gemini'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
    requestApprovalImpl: async () => ({ decision: 'deny' })
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), {
    decision: 'deny',
    reason: 'Denied remotely via Nofax.'
  });
  assert.equal(stderr.read(), '');
});

test('Gemini BeforeTool timeout emits strict native-confirmation JSON', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'BeforeTool', cwd: '/repo', tool_name: 'write_file', tool_input: { file_path: 'README.md' }
  });
  const code = await runCli(['hook', 'gemini'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
    requestApprovalImpl: async () => ({ decision: 'timeout' })
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), { decision: 'ask' });
  assert.equal(stderr.read(), '');
});

test('Gemini hook setup failure forces native confirmation instead of escaping the CLI boundary', async () => {
  const stdout = capture();
  const stderr = capture();
  const input = JSON.stringify({
    hook_event_name: 'BeforeTool', cwd: '/repo', tool_name: 'write_file', tool_input: { file_path: 'README.md' }
  });
  const code = await runCli(['hook', 'gemini'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => { throw new Error('NOFAX_CONFIG_MISSING'); }
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), { decision: 'ask' });
  assert.match(stderr.read(), /NOFAX_CONFIG_MISSING/);
});
test('help is concise and lists supported commands', async () => {
  const stdout = capture();
  const code = await runCli(['--help'], { stdout, stderr: capture() });
  assert.equal(code, 0);
  assert.match(stdout.read(), /nofax init/);
  assert.match(stdout.read(), /nofax hook claude/);
  assert.match(stdout.read(), /nofax hook codex/);
  assert.match(stdout.read(), /nofax hook gemini/);
  assert.match(stdout.read(), /nofax --version/);
});

test('version flags print the installed package version without config access', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  for (const flag of ['--version', '-v']) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli([flag], {
      stdout,
      stderr,
      loadConfigImpl: async () => { throw new Error('config should not be loaded'); }
    });
    assert.equal(code, 0);
    assert.equal(stdout.read(), `${metadata.version}\n`);
    assert.equal(stderr.read(), '');
  }
});

test('command-specific flags are rejected instead of silently ignored', async () => {
  for (const [args, unexpectedFlag] of [
    [['notify', '--server', 'https://example.com', 'hello'], '--server'],
    [['approve', '--timeout', '5', 'ship it'], '--timeout'],
    [['refine', '--topic', 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', 'rewrite it'], '--topic']
  ]) {
    const stdout = capture();
    const stderr = capture();
    let sideEffects = 0;
    const code = await runCli(args, {
      stdout,
      stderr,
      loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
      sendNotificationImpl: async () => { sideEffects += 1; },
      requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; },
      requestRefinementImpl: async () => { sideEffects += 1; return { decision: 'refine', text: 'ok' }; }
    });
    assert.equal(code, 1);
    assert.equal(sideEffects, 0);
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), new RegExp(`NOFAX_UNKNOWN_FLAG:${unexpectedFlag}`));
  }
});

test('value-taking flags do not swallow a following recognized flag', async () => {
  const stdout = capture();
  const stderr = capture();
  let sideEffects = 0;
  const code = await runCli(['notify', '--title', '--server', 'hello'], {
    stdout,
    stderr,
    loadConfigImpl: async () => ({ version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 }),
    sendNotificationImpl: async () => { sideEffects += 1; }
  });
  assert.equal(code, 1);
  assert.equal(sideEffects, 0);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /NOFAX_FLAG_VALUE:--title/);
});

test('commands without positional arguments reject trailing input before side effects', async () => {
  for (const args of [
    ['init', 'unexpected'],
    ['config', 'unexpected'],
    ['test', 'unexpected'],
    ['mcp', 'unexpected'],
    ['hook', 'claude', 'unexpected']
  ]) {
    const stdout = capture();
    const stderr = capture();
    let sideEffects = 0;
    const code = await runCli(args, {
      stdout,
      stderr,
      stdinText: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' }
      }),
      initConfigImpl: async () => {
        sideEffects += 1;
        return { server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF' };
      },
      loadConfigImpl: async () => {
        sideEffects += 1;
        return { version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 };
      },
      sendNotificationImpl: async () => { sideEffects += 1; },
      requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; },
      runMcpServerImpl: async () => { sideEffects += 1; }
    });
    assert.equal(code, 1);
    assert.equal(sideEffects, 0);
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), /NOFAX_UNEXPECTED_ARGUMENT:unexpected/);
  }
});
