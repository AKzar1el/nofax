import test from 'node:test';
import assert from 'node:assert/strict';
import { handleClaudePermissionRequest } from '../src/adapters/claude.mjs';
import { handleCodexPermissionRequest } from '../src/adapters/codex.mjs';
import { handleGeminiHook, handleGeminiNotification } from '../src/adapters/gemini.mjs';

const config = { version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 };

const claudeInput = {
  session_id: 's1',
  cwd: '/repo',
  hook_event_name: 'PermissionRequest',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', password: 'hidden' },
  permission_suggestions: []
};

const codexInput = {
  session_id: 's2',
  turn_id: 't1',
  cwd: '/repo',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5',
  permission_mode: 'default',
  transcript_path: null,
  tool_name: 'Bash',
  tool_input: { command: 'npm test' }
};

test('Claude adapter maps remote allow and deny into native PermissionRequest output', async () => {
  const seen = [];
  const allow = await handleClaudePermissionRequest(claudeInput, {
    config,
    requestApprovalImpl: async (request) => { seen.push(request); return { decision: 'allow' }; }
  });
  assert.deepEqual(allow, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  });
  assert.doesNotMatch(seen[0].message, /hidden/);

  const deny = await handleClaudePermissionRequest(claudeInput, {
    config,
    requestApprovalImpl: async () => ({ decision: 'deny' })
  });
  assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(deny.hookSpecificOutput.decision.message, /Nofax/);
});

test('Claude adapter returns no decision on timeout or transport failure', async () => {
  assert.equal(await handleClaudePermissionRequest(claudeInput, {
    config,
    requestApprovalImpl: async () => ({ decision: 'timeout' })
  }), null);
  const errors = [];
  assert.equal(await handleClaudePermissionRequest(claudeInput, {
    config,
    requestApprovalImpl: async () => { throw new Error('offline'); },
    onError: (error) => errors.push(error.message)
  }), null);
  assert.deepEqual(errors, ['offline']);
});

test('Codex adapter emits only currently supported decision fields', async () => {
  const allow = await handleCodexPermissionRequest(codexInput, {
    config,
    requestApprovalImpl: async () => ({ decision: 'allow' })
  });
  assert.deepEqual(allow, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  });
  const decision = allow.hookSpecificOutput.decision;
  assert.equal('updatedInput' in decision, false);
  assert.equal('updatedPermissions' in decision, false);
  assert.equal('interrupt' in decision, false);
});

test('Codex adapter denies cleanly and falls back natively on timeout', async () => {
  const deny = await handleCodexPermissionRequest(codexInput, {
    config,
    requestApprovalImpl: async () => ({ decision: 'deny' })
  });
  assert.deepEqual(deny.hookSpecificOutput.decision, {
    behavior: 'deny',
    message: 'Denied remotely via Nofax.'
  });
  assert.equal(await handleCodexPermissionRequest(codexInput, {
    config,
    requestApprovalImpl: async () => ({ decision: 'timeout' })
  }), null);
});

test('adapters reject the wrong hook event type', async () => {
  await assert.rejects(() => handleClaudePermissionRequest({ ...claudeInput, hook_event_name: 'Stop' }, { config }), /NOFAX_CLAUDE_EVENT/);
  await assert.rejects(() => handleCodexPermissionRequest({ ...codexInput, hook_event_name: 'Stop' }, { config }), /NOFAX_CODEX_EVENT/);
});

test('Gemini adapter forwards Notification events without pretending to approve them', async () => {
  const sent = [];
  const result = await handleGeminiNotification({
    hook_event_name: 'Notification',
    notification_type: 'ToolPermission',
    message: 'Gemini needs approval',
    details: { tool_name: 'run_shell_command', api_key: 'secret' }
  }, {
    config,
    sendNotificationImpl: async (request) => sent.push(request)
  });
  assert.deepEqual(result, {});
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /Gemini CLI/);
  assert.doesNotMatch(sent[0].message, /secret/);
});

test('Gemini Notification transport failure remains advisory', async () => {
  const errors = [];
  const result = await handleGeminiHook({
    hook_event_name: 'Notification',
    notification_type: 'ToolPermission',
    message: 'Gemini needs approval'
  }, {
    config,
    sendNotificationImpl: async () => { throw new Error('offline'); },
    onError: (error) => errors.push(error.message)
  });
  assert.deepEqual(result, {});
  assert.deepEqual(errors, ['offline']);
});
test('Gemini BeforeTool adapter maps explicit remote allow and deny decisions', async () => {
  const input = {
    session_id: 's3',
    cwd: '/repo',
    hook_event_name: 'BeforeTool',
    timestamp: '2026-09-20T15:00:00Z',
    tool_name: 'run_shell_command',
    tool_input: { command: 'npm test', api_key: 'secret' }
  };
  const seen = [];
  const allow = await handleGeminiHook(input, {
    config,
    requestApprovalImpl: async (request) => { seen.push(request); return { decision: 'allow' }; }
  });
  assert.deepEqual(allow, { decision: 'allow' });
  assert.match(seen[0].title, /Gemini CLI needs approval/);
  assert.doesNotMatch(seen[0].message, /secret/);

  const deny = await handleGeminiHook(input, {
    config,
    requestApprovalImpl: async () => ({ decision: 'deny' })
  });
  assert.deepEqual(deny, {
    decision: 'deny',
    reason: 'Denied remotely via Nofax.'
  });
});

test('Gemini BeforeTool adapter forces native confirmation on timeout or transport failure', async () => {
  const input = {
    session_id: 's4',
    cwd: '/repo',
    hook_event_name: 'BeforeTool',
    timestamp: '2026-09-20T15:00:00Z',
    tool_name: 'write_file',
    tool_input: { file_path: 'README.md' }
  };
  assert.deepEqual(await handleGeminiHook(input, {
    config,
    requestApprovalImpl: async () => ({ decision: 'timeout' })
  }), { decision: 'ask' });

  const errors = [];
  assert.deepEqual(await handleGeminiHook(input, {
    config,
    requestApprovalImpl: async () => { throw new Error('offline'); },
    onError: (error) => errors.push(error.message)
  }), { decision: 'ask' });
  assert.deepEqual(errors, ['offline']);
});

test('provider credential command previews remain private without changing human denial or timeout semantics', async () => {
  const marker = 'NOFAX_CANARY_ADAPTER_P91';
  const cases = [
    `Set-Item -Value '${marker}' -LiteralPath Env:API_KEY; echo mode=safe`,
    `Set-Variable -Confirm:$false -Name:API_KEY -Value:'${marker}'; echo mode=safe`,
    `New-Item -Path Env: -Name API_KEY -Value '${marker}'; echo mode=safe`,
  ];
  for (const command of cases) {
    for (const decision of ['deny', 'timeout']) {
      const seen = [];
      const options = { config, requestApprovalImpl: async ({ message }) => { seen.push(message); return { decision }; } };
      const tool_input = { command, note: 'review context' };
      const claude = await handleClaudePermissionRequest({ ...claudeInput, tool_input }, options);
      const codex = await handleCodexPermissionRequest({ ...codexInput, tool_input }, options);
      const gemini = await handleGeminiHook({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input }, options);
      assert.equal(seen.length, 3);
      for (const message of seen) {
        assert.ok(!message.includes(marker));
        assert.match(message, /REDACTED/);
        assert.match(message, /mode=safe/);
        assert.match(message, /review context/);
      }
      if (decision === 'deny') {
        assert.equal(claude.hookSpecificOutput.decision.behavior, 'deny');
        assert.equal(codex.hookSpecificOutput.decision.behavior, 'deny');
        assert.equal(gemini.decision, 'deny');
      } else {
        assert.equal(claude, null);
        assert.equal(codex, null);
        assert.deepEqual(gemini, { decision: 'ask' });
      }
    }
  }
});

test('structured credential command previews preserve deny, timeout and transport-error decisions', async () => {
  const marker = 'NOFAX_SYNTHETIC_ADAPTER_ARGV_X91';
  const sensitive = ['setx', 'API_KEY', marker];
  const benign = ['setx', 'NOTE', marker];
  const cases = [
    { command: sensitive, masked: true },
    { command: JSON.stringify({ argv: sensitive }), masked: true },
    { command: benign, masked: false },
    { command: JSON.stringify({ argv: benign }), masked: false },
    { command: ['Set-Item', '-Value', marker, '-Path', 'Env:API_KEY'], masked: true },
    { command: JSON.stringify({ argv: ['Set-Variable', '-Name', 'API_KEY', '-Value', marker] }), masked: true },
    { command: ['New-Item', '-Path', 'Env:', '-Value', marker], masked: true },
    { command: ['Set-Variable', '-Value', marker, '-Name', 'NOTE'], masked: false },
    { command: JSON.stringify({ argv: ['Set-Content', '-Path', 'notes with spaces.txt', '-Value', marker] }), masked: false },
    { command: ['python', '-c', "import os; os.environ['API_KEY']='" + marker + "'"], masked: true },
    { command: JSON.stringify({ argv: ['node', '-e', "const e=process.env; e['TOKEN']='" + marker + "'"] }), masked: true },
    { command: ['node', '--eval', "process.env[key]=process.argv[1]", marker], masked: true },
    { command: ['python', '-c', "import os; os.environ['NOTE']='" + marker + "'"], masked: false },
    { command: JSON.stringify({ argv: ['node', '-e', "console.log('" + marker + " process.env')"] }), masked: false },
  ];
  for (const { command, masked } of cases) {
    for (const decision of ['deny', 'timeout', 'error']) {
      const seen = [];
      const errors = [];
      const options = { config, onError: error => errors.push(error.message), requestApprovalImpl: async ({ message }) => {
        seen.push(message);
        if (decision === 'error') throw new Error('synthetic offline');
        return { decision };
      } };
      const tool_input = { command, note: 'safe sibling' };
      const claude = await handleClaudePermissionRequest({ ...claudeInput, tool_input }, options);
      const codex = await handleCodexPermissionRequest({ ...codexInput, tool_input }, options);
      const gemini = await handleGeminiHook({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input }, options);
      assert.equal(seen.length, 3);
      for (const message of seen) {
        assert.equal(message.includes(marker), !masked);
        if (masked) assert.match(message, /REDACTED/);
        assert.match(message, /safe sibling/);
      }
      if (decision === 'deny') {
        assert.equal(claude.hookSpecificOutput.decision.behavior, 'deny');
        assert.equal(codex.hookSpecificOutput.decision.behavior, 'deny');
        assert.equal(gemini.decision, 'deny');
      } else {
        assert.equal(claude, null);
        assert.equal(codex, null);
        assert.deepEqual(gemini, { decision: 'ask' });
      }
      assert.equal(errors.length, decision === 'error' ? 3 : 0);
    }
  }
});

test('adapter notification titles redact untrusted credential-bearing event fields', async () => {
  const secret = 'NOFAX_SYNTHETIC_TITLE_SECRET_12345';
  const toolName = `Bash api_key=${secret}`;
  const titles = [];
  const recordApproval = async ({ title }) => {
    titles.push(title);
    return { decision: 'deny' };
  };
  await handleClaudePermissionRequest({ ...claudeInput, tool_name: toolName }, {
    config,
    requestApprovalImpl: recordApproval
  });
  await handleCodexPermissionRequest({ ...codexInput, tool_name: toolName }, {
    config,
    requestApprovalImpl: recordApproval
  });
  await handleGeminiHook({ hook_event_name: 'BeforeTool', tool_name: toolName }, {
    config,
    requestApprovalImpl: recordApproval
  });
  await handleGeminiNotification({
    hook_event_name: 'Notification',
    notification_type: `ToolPermission token=${secret}`,
    message: 'Synthetic notification'
  }, {
    config,
    sendNotificationImpl: async ({ title }) => { titles.push(title); }
  });

  assert.equal(titles.length, 4);
  for (const title of titles) {
    assert.equal(title.includes(secret), false, 'a phone title must never expose a credential');
    assert.match(title, /\[REDACTED\]/);
  }
  assert.ok(titles[0].includes('Bash'));
  assert.ok(titles[3].includes('ToolPermission'));
});
