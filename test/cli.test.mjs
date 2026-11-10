import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('legacy repeating topic warns without leaking a subscription capability or sending remotely', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-legacy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const topic = 'M9_aBcD2'.repeat(4);
  await writeFile(join(home, 'config.json'), JSON.stringify({
    version: 1, server: 'https://ntfy.sh', topic, timeoutSeconds: 300
  }));
  const initOut = capture();
  const initErr = capture();
  assert.equal(await runCli(['init'], { env: { NOFAX_HOME: home }, stdout: initOut, stderr: initErr }), 1);
  assert.equal(initOut.read(), '');
  assert.match(initErr.read(), /init --force/);
  assert.doesNotMatch(initErr.read(), new RegExp(topic));

  const configOut = capture();
  const configErr = capture();
  assert.equal(await runCli(['config'], { env: { NOFAX_HOME: home }, stdout: configOut, stderr: configErr }), 0);
  assert.equal(JSON.parse(configOut.read()).topic, '[ROTATION_REQUIRED]');
  assert.match(configErr.read(), /init --force/);
  assert.doesNotMatch(configErr.read(), new RegExp(topic));

  let sent = false;
  const notifyOut = capture();
  const notifyErr = capture();
  assert.equal(await runCli(['notify', 'hello'], {
    env: { NOFAX_HOME: home }, stdout: notifyOut, stderr: notifyErr,
    sendNotificationImpl: async () => { sent = true; }
  }), 1);
  assert.equal(sent, false);
  assert.equal(notifyOut.read(), '');
  assert.match(notifyErr.read(), /init --force/);
  assert.doesNotMatch(notifyErr.read(), new RegExp(topic));

  const rotateOut = capture();
  const rotateErr = capture();
  assert.equal(await runCli(['init', '--force'], {
    env: { NOFAX_HOME: home }, stdout: rotateOut, stderr: rotateErr
  }), 0);
  assert.notEqual((await loadConfig({ home })).topic, topic);
  assert.equal(rotateErr.read(), '');
});

test('legacy topic leaves agent hooks on native approval without remote action', async () => {
  const topic = 'M9_aBcD2'.repeat(4);
  const config = { version: 1, server: 'https://ntfy.sh', topic, timeoutSeconds: 300 };
  for (const adapter of ['claude', 'codex', 'gemini']) {
    let remoteCalls = 0;
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['hook', adapter], {
      stdinText: JSON.stringify({
        hook_event_name: adapter === 'gemini' ? 'BeforeTool' : 'PermissionRequest',
        tool_name: 'Bash', tool_input: { command: 'npm test' }
      }),
      stdout, stderr,
      loadConfigImpl: async () => config,
      requestApprovalImpl: async () => { remoteCalls += 1; return { decision: 'allow' }; },
      sendNotificationImpl: async () => { remoteCalls += 1; }
    });
    assert.equal(code, 0);
    assert.equal(remoteCalls, 0);
    assert.equal(stdout.read(), adapter === 'gemini' ? '{"decision":"ask"}\n' : '');
    assert.match(stderr.read(), /init --force/);
    assert.doesNotMatch(stderr.read(), new RegExp(topic));
  }
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

test('generic approve exit codes distinguish explicit allow, deny, timeout and invalid decisions', async () => {
  for (const [decision, exitCode] of [['allow', 0], ['deny', 2], ['timeout', 3], ['unexpected', 1]]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['approve', 'Run deployment?'], {
      stdout,
      stderr,
      loadConfigImpl: async () => ({}),
      requestApprovalImpl: async () => ({ decision })
    });
    assert.equal(code, exitCode, `decision ${decision} must not be mistaken for success`);
    assert.equal(stdout.read(), `${JSON.stringify({ decision })}\n`);
    assert.equal(stderr.read(), '');
  }
});

test('CLI error diagnostics quote terminal controls and forged log lines', async () => {
  const injected = 'upstream failed \x1b[2J\nnofax: approved \u202eDENY';
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['notify', 'Safe test'], {
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    sendNotificationImpl: async () => { throw new Error(injected); }
  });
  assert.equal(code, 1);
  assert.equal(stdout.read(), '');
  assert.equal(stderr.read(), 'nofax: upstream failed \\u001b[2J\\u000anofax: approved \\u202eDENY\n');
});

test('CLI diagnostics expose invisible Unicode that can disguise approval words', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['notify', 'Check status'], {
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    sendNotificationImpl: async () => {
      throw new Error('A\u200blow D\u200deny \u00ad\u2060\ufeff');
    }
  });
  assert.equal(code, 1);
  assert.equal(stdout.read(), '');
  assert.equal(stderr.read(), 'nofax: A\\u200blow D\\u200deny \\u00ad\\u2060\\ufeff\n');
});

test('hook approval errors cannot inject terminal controls into fallback diagnostics', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['hook', 'claude'], {
    stdinText: JSON.stringify({
      hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }
    }),
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    requestApprovalImpl: async () => { throw new Error('transport \x1b[1m\u2067injected'); }
  });
  assert.equal(code, 0, 'remote failure must defer to native approval');
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /transport \\u001b\[1m\\u2067injected/);
  assert.doesNotMatch(stderr.read(), /[\x1b\u2067]/u);
  assert.match(stderr.read(), /native approval/i);
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

test('oversized hook JSON is rejected before configuration or remote approval for every adapter', async () => {
  const oversizedCommand = 'x'.repeat(1024 * 1024);
  for (const adapter of ['claude', 'codex', 'gemini']) {
    const stdout = capture();
    const stderr = capture();
    let sideEffects = 0;
    const code = await runCli(['hook', adapter], {
      stdinText: JSON.stringify({
        hook_event_name: adapter === 'gemini' ? 'BeforeTool' : 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: oversizedCommand }
      }),
      stdout,
      stderr,
      loadConfigImpl: async () => { sideEffects += 1; return {}; },
      requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
    });
    assert.equal(code, 0, `${adapter} should defer to native approval`);
    assert.equal(sideEffects, 0, `${adapter} should not load config or contact a phone`);
    assert.match(stderr.read(), /NOFAX_HOOK_INPUT_TOO_LARGE/);
    assert.equal(stdout.read(), adapter === 'gemini' ? '{"decision":"ask"}\n' : '');
  }
});

test('hook stdin accepts valid JSON at the exact 1 MiB byte boundary', async () => {
  const base = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: '' } };
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const input = JSON.stringify({
    ...base,
    tool_input: { command: 'x'.repeat(1024 * 1024 - baseBytes) }
  });
  assert.equal(Buffer.byteLength(input), 1024 * 1024);

  const stdout = capture();
  const stderr = capture();
  let approvals = 0;
  const code = await runCli(['hook', 'claude'], {
    stdinText: input,
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    requestApprovalImpl: async () => { approvals += 1; return { decision: 'deny' }; }
  });
  assert.equal(code, 0);
  assert.equal(approvals, 1);
  assert.equal(JSON.parse(stdout.read()).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(stderr.read(), '');
});

test('direct hook stdinText rejects lone UTF-16 surrogates before approval', async () => {
  for (const adapter of ['claude', 'codex', 'gemini']) {
    const input = JSON.stringify({
      hook_event_name: adapter === 'gemini' ? 'BeforeTool' : 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'echo X' }
    });
    for (const surrogate of ['\uD83E', '\uDD84']) {
      const malformed = input.replace('echo X', `echo ${surrogate}`);
      assert.equal(malformed.isWellFormed(), false);
      assert.doesNotThrow(() => JSON.parse(malformed));
      const stdout = capture();
      const stderr = capture();
      let sideEffects = 0;
      const code = await runCli(['hook', adapter], {
        stdinText: malformed,
        stdout,
        stderr,
        loadConfigImpl: async () => { sideEffects += 1; return {}; },
        requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
      });
      assert.equal(code, 0, `${adapter} should fall back to native approval`);
      assert.equal(sideEffects, 0, 'malformed text must not load config or contact a phone');
      assert.match(stderr.read(), /NOFAX_HOOK_INVALID_UTF8/);
      assert.equal(stdout.read(), adapter === 'gemini' ? '{"decision":"ask"}\n' : '');
    }
  }
});

test('streamed hook input stops at the byte limit before consuming later chunks', async () => {
  let yielded = 0;
  let sideEffects = 0;
  async function* stdinStream() {
    yielded += 1;
    yield Buffer.from('{"hook_event_name":"PermissionRequest",');
    yielded += 1;
    yield Buffer.alloc(1024 * 1024, 32);
    yielded += 1;
    yield Buffer.from('"tool_name":"Bash"}');
  }
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['hook', 'codex'], {
    stdinStream: stdinStream(),
    stdout,
    stderr,
    loadConfigImpl: async () => { sideEffects += 1; return {}; },
    requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
  });
  assert.equal(code, 0);
  assert.equal(yielded, 2, 'reject the oversized chunk without reading subsequent input');
  assert.equal(sideEffects, 0);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /NOFAX_HOOK_INPUT_TOO_LARGE/);
});

test('streamed hook input preserves a UTF-8 character split across byte chunks', async () => {
  const input = Buffer.from(JSON.stringify({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo 🦄' }
  }));
  const emojiStart = input.indexOf(Buffer.from('🦄'));
  assert.ok(emojiStart > 0);
  async function* stdinStream() {
    yield input.subarray(0, emojiStart + 1);
    yield input.subarray(emojiStart + 1);
  }
  const stdout = capture();
  const stderr = capture();
  let approvedMessage;
  const code = await runCli(['hook', 'claude'], {
    stdinStream: stdinStream(),
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    requestApprovalImpl: async ({ message }) => {
      approvedMessage = message;
      return { decision: 'deny' };
    }
  });
  assert.equal(code, 0);
  assert.match(approvedMessage, /🦄/);
  assert.equal(JSON.parse(stdout.read()).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(stderr.read(), '');
});

test('streamed hook input rejects malformed UTF-8 before loading config or requesting approval', async () => {
  const payload = Buffer.from(JSON.stringify({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo X' }
  }));
  const byteIndex = payload.indexOf(Buffer.from('X'));
  assert.ok(byteIndex > 0);
  payload[byteIndex] = 0xff;

  for (const adapter of ['claude', 'codex', 'gemini']) {
    async function* stdinStream() {
      yield payload.subarray(0, byteIndex + 1);
      yield payload.subarray(byteIndex + 1);
    }
    const stdout = capture();
    const stderr = capture();
    let sideEffects = 0;
    const code = await runCli(['hook', adapter], {
      stdinStream: stdinStream(),
      stdout,
      stderr,
      loadConfigImpl: async () => { sideEffects += 1; return {}; },
      requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
    });
    assert.equal(code, 0);
    assert.equal(sideEffects, 0, 'invalid bytes must not reach the approval flow');
    assert.match(stderr.read(), /NOFAX_HOOK_INVALID_UTF8/);
    if (adapter === 'gemini') assert.deepEqual(JSON.parse(stdout.read()), { decision: 'ask' });
    else assert.equal(stdout.read(), '');
  }
});

test('string-stream hook input rejects lone UTF-16 surrogates before remote approval', async () => {
  const validJson = JSON.stringify({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo X' }
  });
  const splitAt = validJson.indexOf('X');
  for (const chunks of [
    [validJson.replace('echo X', 'echo \uD83E!')],
    [validJson.replace('echo X', 'echo \uDD84')],
    [validJson.slice(0, splitAt) + '\uD83E', Buffer.from(validJson.slice(splitAt + 1))]
  ]) {
    for (const adapter of ['claude', 'codex', 'gemini']) {
      async function* stdinStream() {
        yield* chunks;
      }
      const stdout = capture();
      const stderr = capture();
      let sideEffects = 0;
      const code = await runCli(['hook', adapter], {
        stdinStream: stdinStream(),
        stdout,
        stderr,
        loadConfigImpl: async () => { sideEffects += 1; return {}; },
        requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
      });
      assert.equal(code, 0);
      assert.equal(sideEffects, 0, 'malformed text must not reach configuration or approval');
      assert.match(stderr.read(), /NOFAX_HOOK_INVALID_UTF8/);
      if (adapter === 'gemini') assert.deepEqual(JSON.parse(stdout.read()), { decision: 'ask' });
      else assert.equal(stdout.read(), '');
    }
  }
});

test('streamed hook input preserves a surrogate pair split across string chunks', async () => {
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo 🦄' }
  });
  const emojiStart = input.indexOf('🦄');
  assert.ok(emojiStart > 0);
  async function* stdinStream() {
    yield input.slice(0, emojiStart + 1);
    yield input.slice(emojiStart + 1);
  }

  const stdout = capture();
  const stderr = capture();
  let approvalMessage;
  const code = await runCli(['hook', 'claude'], {
    stdinStream: stdinStream(),
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    requestApprovalImpl: async ({ message }) => {
      approvalMessage = message;
      return { decision: 'deny' };
    }
  });
  assert.equal(code, 0);
  assert.match(approvalMessage, /🦄/);
  assert.equal(JSON.parse(stdout.read()).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(stderr.read(), '');
});

test('string chunks with a split surrogate cannot bypass the 1 MiB input limit', async () => {
  let yielded = 0;
  async function* stdinStream() {
    yielded += 1;
    yield 'x'.repeat(1024 * 1024 - 1);
    yielded += 1;
    yield '\uD83E';
    yielded += 1;
    yield '\uDD84';
    yielded += 1;
    yield 'this must not be read';
  }
  const stdout = capture();
  const stderr = capture();
  let sideEffects = 0;
  const code = await runCli(['hook', 'codex'], {
    stdinStream: stdinStream(),
    stdout,
    stderr,
    loadConfigImpl: async () => { sideEffects += 1; return {}; },
    requestApprovalImpl: async () => { sideEffects += 1; return { decision: 'allow' }; }
  });
  assert.equal(code, 0);
  assert.equal(yielded, 3);
  assert.equal(sideEffects, 0);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /NOFAX_HOOK_INPUT_TOO_LARGE/);
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
