import test from 'node:test';
import assert from 'node:assert/strict';
import { handleClaudePermissionRequest } from '../src/adapters/claude.mjs';
import { handleCodexPermissionRequest } from '../src/adapters/codex.mjs';
import { handleGeminiNotification } from '../src/adapters/gemini.mjs';

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
