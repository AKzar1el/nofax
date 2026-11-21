import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { savePendingRequest, resolveRequest } from '../src/requests.mjs';

function capture() {
  let text = '';
  return { write: (chunk) => { text += String(chunk); }, read: () => text };
}

test('config masks its notification capability by default and reveals it only on request', async () => {
  const topic = 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF';
  const config = { version: 1, server: 'https://ntfy.example.invalid', topic, timeoutSeconds: 725 };
  const sideEffect = async () => { throw new Error('CONFIG_MUST_NOT_CONTACT_PHONE'); };
  for (const [args, expectedTopic] of [
    [['config'], '[REDACTED]'],
    [['config', '--show-topic'], topic]
  ]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(args, {
      stdout, stderr,
      loadConfigImpl: async () => config,
      initConfigImpl: sideEffect,
      sendNotificationImpl: sideEffect,
      requestApprovalImpl: sideEffect
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout.read()), { ...config, topic: expectedTopic });
    assert.equal(stderr.read(), '');
    if (expectedTopic !== topic) assert.doesNotMatch(stdout.read(), new RegExp(topic));
  }
});

test('config never reveals a legacy repeated topic even with an explicit reveal flag', async () => {
  const topic = 'M9_aBcD2'.repeat(4);
  const config = { version: 1, server: 'https://ntfy.sh', topic, timeoutSeconds: 300 };
  for (const args of [['config'], ['config', '--show-topic']]) {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await runCli(args, {
      stdout, stderr, loadConfigImpl: async () => config,
      sendNotificationImpl: async () => { throw new Error('MUST_NOT_SEND'); }
    }), 0);
    assert.deepEqual(JSON.parse(stdout.read()), { ...config, topic: '[ROTATION_REQUIRED]' });
    assert.match(stderr.read(), /init --force/);
    assert.doesNotMatch(stdout.read() + stderr.read(), new RegExp(topic));
  }
});

test('pending lists only local public request metadata with a bounded limit', async () => {
  const stdout = capture();
  const stderr = capture();
  let calls = 0;
  const code = await runCli(['pending', '--limit', '1'], {
    stdout, stderr,
    loadConfigImpl: async () => { throw new Error('PENDING_MUST_NOT_READ_NOTIFICATION_CONFIG'); },
    sendNotificationImpl: async () => { throw new Error('PENDING_MUST_NOT_NOTIFY'); },
    requestApprovalImpl: async () => { throw new Error('PENDING_MUST_NOT_APPROVE'); },
    listPendingRequestsImpl: async ({ limit }) => {
      calls += 1;
      assert.equal(limit, 1);
      return [{
        requestId: 'req_pending_example', kind: 'approval', status: 'pending',
        createdAt: '2026-11-11T02:00:00.000Z',
        title: 'SECRET_TITLE', message: 'SECRET_MESSAGE', topic: 'SECRET_TOPIC',
        text: 'SECRET_DECISION_TEXT'
      }];
    }
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout.read()), { requests: [{
    requestId: 'req_pending_example', kind: 'approval', status: 'pending',
    createdAt: '2026-11-11T02:00:00.000Z'
  }] });
  assert.equal(stderr.read(), '');
  assert.doesNotMatch(stdout.read(), /SECRET_/);
});

test('pending reads real local records and excludes a human-denied terminal request', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-pending-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const record = {
    version: 1, requestId: 'nfx_abcdefghijklmnopqrstuvwx', kind: 'approval',
    responseTopic: 'nofax_r_private_response_capability', allowed: ['allow', 'deny'],
    status: 'pending', createdAt: '2026-11-11T02:00:00.000Z'
  };
  await savePendingRequest({ home, request: record });
  await savePendingRequest({ home, request: {
    ...record, requestId: 'nfx_abcdefghijklmnopqrstuvw0',
    createdAt: '2026-11-11T02:01:00.000Z'
  } });
  await resolveRequest({
    home, requestId: record.requestId, response: { decision: 'deny' },
    resolvedAt: '2026-11-11T02:02:00.000Z'
  });
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(['pending'], {
    env: { NOFAX_HOME: home }, stdout, stderr
  }), 0);
  assert.deepEqual(JSON.parse(stdout.read()), { requests: [{
    requestId: 'nfx_abcdefghijklmnopqrstuvw0', kind: 'approval',
    status: 'pending', createdAt: '2026-11-11T02:01:00.000Z'
  }] });
  assert.equal(stderr.read(), '');
  assert.doesNotMatch(stdout.read(), /private_response_capability|deny/);
});

test('pending defaults to twenty and rejects invalid limits before scanning', async () => {
  const stdout = capture();
  const stderr = capture();
  let calls = 0;
  assert.equal(await runCli(['pending'], {
    stdout, stderr,
    listPendingRequestsImpl: async ({ limit }) => {
      calls += 1;
      assert.equal(limit, 20);
      return [];
    }
  }), 0);
  assert.deepEqual(JSON.parse(stdout.read()), { requests: [] });
  assert.equal(stderr.read(), '');
  assert.equal(calls, 1);

  for (const value of ['0', '101', '1.5', 'NaN']) {
    const out = capture();
    const err = capture();
    assert.equal(await runCli(['pending', '--limit', value], {
      stdout: out, stderr: err,
      listPendingRequestsImpl: async () => { throw new Error('MUST_NOT_SCAN'); }
    }), 1);
    assert.equal(out.read(), '');
    assert.match(err.read(), /NOFAX_REQUEST_LIMIT_INVALID/);
  }
});

test('pending fails closed when local request records are corrupt', async () => {
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(['pending'], {
    stdout, stderr,
    listPendingRequestsImpl: async () => { throw new Error('NOFAX_REQUEST_INVALID_JSON'); }
  }), 1);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /NOFAX_REQUEST_INVALID_JSON/);
});

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

test('init shows the subscription capability only when created or explicitly rotated', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-init-repeat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { NOFAX_HOME: home };
  const first = capture();
  assert.equal(await runCli(['init'], { env, stdout: first, stderr: capture() }), 0);
  const original = await loadConfig({ home });
  assert.match(first.read(), new RegExp(original.topic));

  const repeat = capture();
  assert.equal(await runCli(['init'], { env, stdout: repeat, stderr: capture() }), 0);
  assert.match(repeat.read(), /already initialized/);
  assert.match(repeat.read(), /config --show-topic/);
  assert.doesNotMatch(repeat.read(), new RegExp(original.topic));
  assert.deepEqual(await loadConfig({ home }), original);

  const rotated = capture();
  assert.equal(await runCli(['init', '--force'], { env, stdout: rotated, stderr: capture() }), 0);
  const changed = await loadConfig({ home });
  assert.notEqual(changed.topic, original.topic);
  assert.match(rotated.read(), new RegExp(changed.topic));
});

test('init --force rotates the topic without silently switching an existing custom server', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-force-preserve-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { NOFAX_HOME: home };
  const firstOutput = capture();
  assert.equal(await runCli(['init', '--server', 'https://private.example.invalid', '--timeout', '725'], {
    env, stdout: firstOutput, stderr: capture()
  }), 0);
  const first = await loadConfig({ home });

  const rotatedOutput = capture();
  assert.equal(await runCli(['init', '--force'], {
    env, stdout: rotatedOutput, stderr: capture()
  }), 0);
  const rotated = await loadConfig({ home });
  assert.notEqual(rotated.topic, first.topic);
  assert.equal(rotated.server, first.server);
  assert.equal(rotated.timeoutSeconds, first.timeoutSeconds);
  assert.match(rotatedOutput.read(), new RegExp(`${rotated.server}/${rotated.topic}`));
});

test('init --force requires a new server when the saved private endpoint is malformed', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-force-invalid-server-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { NOFAX_HOME: home };
  assert.equal(await runCli(['init', '--server', 'https://private.example.invalid'], {
    env, stdout: capture(), stderr: capture()
  }), 0);
  const first = await loadConfig({ home });
  const path = join(home, 'config.json');
  const malformed = JSON.stringify({ ...first, server: 'https://private.example.invalid/unexpected' });
  await writeFile(path, malformed);

  const failedOutput = capture();
  const failedError = capture();
  assert.equal(await runCli(['init', '--force'], {
    env, stdout: failedOutput, stderr: failedError
  }), 1);
  assert.equal(failedOutput.read(), '');
  assert.match(failedError.read(), /NOFAX_SERVER_REQUIRES_EXPLICIT_REPLACEMENT.*--server.*--force/);
  assert.doesNotMatch(failedError.read(), /private\.example|nofax_[A-Za-z0-9_-]+/);
  assert.equal(await readFile(path, 'utf8'), malformed);

  const recoveredOutput = capture();
  assert.equal(await runCli(['init', '--force', '--server', 'https://replacement.example.invalid'], {
    env, stdout: recoveredOutput, stderr: capture()
  }), 0);
  const recovered = await loadConfig({ home });
  assert.equal(recovered.server, 'https://replacement.example.invalid');
  assert.notEqual(recovered.topic, first.topic);
  assert.match(recoveredOutput.read(), new RegExp(recovered.topic));
});

test('init --force never discloses or silently replaces an unreadable private config', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-force-corrupt-private-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { NOFAX_HOME: home };
  const path = join(home, 'config.json');
  const malformed = '{"server":"https://private.example.invalid","topic":"sensitive-topic","version":';
  await writeFile(path, malformed);

  const failedOutput = capture();
  const failedError = capture();
  assert.equal(await runCli(['init', '--force'], {
    env, stdout: failedOutput, stderr: failedError
  }), 1);
  assert.equal(failedOutput.read(), '');
  assert.match(failedError.read(), /NOFAX_SERVER_REQUIRES_EXPLICIT_REPLACEMENT.*--server.*--force/);
  assert.doesNotMatch(failedError.read(), /private\.example|sensitive-topic/);
  assert.equal(await readFile(path, 'utf8'), malformed);

  const recoveredOutput = capture();
  assert.equal(await runCli(['init', '--force', '--server', 'https://private.example.invalid'], {
    env, stdout: recoveredOutput, stderr: capture()
  }), 0);
  const recovered = await loadConfig({ home });
  assert.equal(recovered.server, 'https://private.example.invalid');
  assert.match(recoveredOutput.read(), new RegExp(recovered.topic));
});

test('concurrent initializers disclose only the winning new subscription topic', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-init-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['init'], { env: { NOFAX_HOME: home }, stdout, stderr });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  }));
  const { topic } = await loadConfig({ home });
  assert.equal(results.filter(({ stdout }) => stdout.includes(topic)).length, 1);
  for (const { code, stdout, stderr } of results) {
    assert.equal(code, 0);
    assert.equal(stderr, '');
    if (!stdout.includes(topic)) {
      assert.match(stdout, /already initialized/);
      assert.match(stdout, /config --show-topic/);
    }
  }
});

test('init rejects ignored overrides for an existing config without leaking the phone topic', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-cli-init-overrides-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const originalOut = capture();
  assert.equal(await runCli(['init', '--server', 'https://original.example.invalid', '--timeout', '725'], {
    env: { NOFAX_HOME: home }, stdout: originalOut, stderr: capture()
  }), 0);
  const original = await loadConfig({ home });

  for (const options of [
    ['--server', 'https://new.example.invalid'],
    ['--timeout', '180'],
    ['--topic', 'validDistinctPhoneTopic_abcDEF12345'],
    ['--timeout', 'NaN']
  ]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['init', ...options], {
      env: { NOFAX_HOME: home }, stdout, stderr,
      sendNotificationImpl: async () => { throw new Error('UNEXPECTED_NOTIFICATION'); }
    });
    assert.equal(code, 1, options.join(' '));
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), /NOFAX_INIT_OPTIONS_REQUIRE_FORCE.*init --force/);
    assert.doesNotMatch(stderr.read(), new RegExp(original.topic));
    assert.deepEqual(await loadConfig({ home }), original);
  }

  const again = capture();
  assert.equal(await runCli(['init'], {
    env: { NOFAX_HOME: home }, stdout: again, stderr: capture()
  }), 0);
  assert.match(again.read(), /Nofax ready/);

  const changed = capture();
  assert.equal(await runCli(['init', '--force', '--timeout', '180'], {
    env: { NOFAX_HOME: home }, stdout: changed, stderr: capture()
  }), 0);
  assert.equal((await loadConfig({ home })).timeoutSeconds, 180);
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

test('CLI diagnostics escape blank filler and formatting marks used to spoof decision words', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['notify', 'Check status'], {
    stdout,
    stderr,
    loadConfigImpl: async () => ({}),
    sendNotificationImpl: async () => {
      throw new Error('A\u115flow D\u1160eny \u2800\u3164\uffa0\u206a\u206f\ufe0e');
    }
  });
  assert.equal(code, 1);
  assert.equal(stdout.read(), '');
  assert.equal(
    stderr.read(),
    'nofax: A\\u115flow D\\u1160eny \\u2800\\u3164\\uffa0\\u206a\\u206f\\ufe0e\n'
  );
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
  assert.match(stdout.read(), /nofax config \[--show-topic\]/);
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
