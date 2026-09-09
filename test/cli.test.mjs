import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('help is concise and lists supported commands', async () => {
  const stdout = capture();
  const code = await runCli(['--help'], { stdout, stderr: capture() });
  assert.equal(code, 0);
  assert.match(stdout.read(), /nofax init/);
  assert.match(stdout.read(), /nofax hook claude/);
  assert.match(stdout.read(), /nofax hook codex/);
});
