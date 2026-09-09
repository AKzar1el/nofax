import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefineShortcutUrl,
  createRemoteRequest,
  pollRemoteResponse,
  requestApproval
} from '../src/ntfy.mjs';

const config = {
  server: 'https://ntfy.sh',
  topic: 'nofax_abcdefghijklmnopqrstuvwxyz123456',
  timeoutSeconds: 30,
  refineShortcutName: 'Nofax Refine'
};

test('refine shortcut URL carries a one-time callback payload', () => {
  const url = buildRefineShortcutUrl({
    shortcutName: 'Nofax Refine',
    server: 'https://ntfy.sh',
    responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz123456',
    requestId: 'nfx_abcdefghijklmnopqrstuvwx'
  });
  assert.match(url, /^shortcuts:\/\/run-shortcut\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('name'), 'Nofax Refine');
  const payload = JSON.parse(parsed.searchParams.get('text'));
  assert.equal(payload.requestId, 'nfx_abcdefghijklmnopqrstuvwx');
  assert.equal(payload.callbackUrl, 'https://ntfy.sh/nofax_r_abcdefghijklmnopqrstuvwxyz123456');
});

test('createRemoteRequest can publish Allow Refine Deny actions', async () => {
  let payload;
  const fetchImpl = async (_url, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 200 };
  };
  const remote = await createRemoteRequest({
    config,
    title: 'Deploy?',
    message: 'Release ready',
    options: [
      { value: 'allow', label: 'Allow' },
      { value: 'deny', label: 'Deny' }
    ],
    includeRefine: true,
    fetchImpl
  });
  assert.equal(payload.actions.length, 3);
  assert.deepEqual(payload.actions.map((a) => a.label), ['Allow', 'Refine', 'Deny']);
  assert.equal(payload.actions[1].action, 'view');
  assert.deepEqual(remote.allowed, ['allow', 'refine', 'deny']);
});

test('pollRemoteResponse returns structured refinement text', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => `${JSON.stringify({ event: 'message', message: JSON.stringify({ v: 1, requestId: 'nfx_abcdefghijklmnopqrstuvwx', decision: 'refine', text: 'shorter please' }) })}\n`
  });
  const result = await pollRemoteResponse({
    config,
    responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz123456',
    requestId: 'nfx_abcdefghijklmnopqrstuvwx',
    allowed: ['refine'],
    fetchImpl
  });
  assert.deepEqual(result, { decision: 'refine', text: 'shorter please' });
});

test('requestApproval sends best-effort phone confirmation after Allow', async () => {
  const published = [];
  let polls = 0;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'POST') {
      published.push(JSON.parse(init.body));
      if (published.length === 2) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    }
    polls += 1;
    const requestId = JSON.parse(published[0].actions[0].body).requestId;
    return {
      ok: true,
      status: 200,
      text: async () => `${JSON.stringify({ event: 'message', message: JSON.stringify({ v: 1, requestId, decision: 'allow' }) })}\n`
    };
  };
  const result = await requestApproval({
    config,
    title: 'Test',
    message: 'Approve?',
    fetchImpl,
    timeoutMs: 1000,
    pollIntervalMs: 1,
    sleepImpl: async () => {},
    nowImpl: (() => { let n = 0; return () => (n += 10); })()
  });
  assert.equal(result.decision, 'allow');
  assert.equal(published.length, 2);
  assert.match(published[1].title, /Approved/);
  assert.equal(polls, 1);
});
