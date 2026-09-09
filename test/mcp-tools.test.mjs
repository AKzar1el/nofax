import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpToolHandlers, WAIT_REQUIRED } from '../src/mcp-tools.mjs';
import { loadRequest } from '../src/requests.mjs';

const config = {
  version: 1,
  server: 'https://ntfy.sh',
  topic: 'nofax_abcdefghijklmnopqrstuvwxyz123456',
  timeoutSeconds: 300
};

async function makeHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'nofax-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeHandlers({ home, pollResult = null, onConfirm = () => {}, onNotify = () => {} } = {}) {
  let seq = 0;
  return createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    sendNotificationImpl: async (input) => onNotify(input),
    createRemoteRequestImpl: async (input) => {
      seq += 1;
      return {
        requestId: `nfx_abcdefghijklmnopqrstuv${String(seq).padStart(2, '0')}`,
        responseTopic: `nofax_r_abcdefghijklmnopqrstuvwxyz1234${String(seq).padStart(2, '0')}`,
        allowed: input.includeRefine
          ? (input.options.length === 2 ? [input.options[0].value, 'refine', input.options[1].value] : ['refine'])
          : input.options.map((option) => option.value)
      };
    },
    pollRemoteResponseImpl: async () => pollResult,
    sendResponseConfirmationImpl: async (input) => onConfirm(input),
    nowImpl: (() => { let t = 0; return () => (t += 1000); })(),
    sleepImpl: async () => {}
  });
}

test('approval returns a durable pending handle and mandatory repeated-wait instruction', async (t) => {
  const home = await makeHome(t);
  const handlers = makeHandlers({ home });
  const result = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready', allowRefine: true });
  assert.equal(result.status, 'pending');
  assert.equal(result.mustWait, true);
  assert.match(result.instruction, /nofax_wait_for_response/);
  assert.match(result.instruction, /repeat/i);
  assert.equal('responseTopic' in result, false);
  const stored = await loadRequest({ home, requestId: result.requestId });
  assert.equal(stored.responseTopic.startsWith('nofax_r_'), true);
  assert.deepEqual(stored.allowed, ['allow', 'refine', 'deny']);
});

test('wait returns pending and repeats the mandatory wait contract when no phone response exists', async (t) => {
  const home = await makeHome(t);
  const handlers = makeHandlers({ home });
  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });
  assert.equal(result.status, 'pending');
  assert.equal(result.mustWait, true);
  assert.equal(result.instruction, WAIT_REQUIRED(pending.requestId));
});

test('wait persists terminal approval, confirms phone, and permits caller to act', async (t) => {
  const home = await makeHome(t);
  let confirmations = 0;
  const handlers = makeHandlers({ home, pollResult: { decision: 'allow' }, onConfirm: () => { confirmations += 1; } });
  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });
  assert.deepEqual(result, {
    status: 'resolved',
    requestId: pending.requestId,
    decision: 'allow',
    instruction: 'Human approved this request. The caller may continue only within its existing authority.'
  });
  assert.equal(confirmations, 1);
  const stored = await loadRequest({ home, requestId: pending.requestId });
  assert.equal(stored.status, 'resolved');
  assert.equal(stored.decision, 'allow');
});

test('refinement returns user text and requires a new approval when needed', async (t) => {
  const home = await makeHome(t);
  const handlers = makeHandlers({ home, pollResult: { decision: 'refine', text: 'Make it shorter.' } });
  const pending = await handlers.requestRefinement({ title: 'Refine draft', message: 'Draft ready' });
  const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });
  assert.equal(result.status, 'resolved');
  assert.equal(result.decision, 'refine');
  assert.equal(result.text, 'Make it shorter.');
  assert.match(result.instruction, /new approval/i);
});

test('notify is one-way and does not create a wait contract', async (t) => {
  const home = await makeHome(t);
  let sent = 0;
  const handlers = makeHandlers({ home, onNotify: () => { sent += 1; } });
  const result = await handlers.notify({ title: 'Build', message: 'Done' });
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(sent, 1);
});

test('listPending exposes safe metadata only', async (t) => {
  const home = await makeHome(t);
  const handlers = makeHandlers({ home });
  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const list = await handlers.listPending({ limit: 10 });
  assert.equal(list.status, 'ok');
  assert.equal(list.requests[0].requestId, pending.requestId);
  assert.equal('responseTopic' in list.requests[0], false);
});
