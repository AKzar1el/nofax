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

test('createRemoteRequest prepares response handles before publishing the notification', async () => {
  const order = [];
  let prepared;
  const remote = await createRemoteRequest({
    config,
    title: 'Deploy?',
    message: 'Release ready',
    options: [
      { value: 'allow', label: 'Allow' },
      { value: 'deny', label: 'Deny' }
    ],
    beforePublish: async (value) => {
      order.push('prepared');
      prepared = value;
    },
    fetchImpl: async () => {
      order.push('published');
      return { ok: true, status: 200 };
    }
  });
  assert.deepEqual(order, ['prepared', 'published']);
  assert.deepEqual(prepared, remote);
  assert.equal(prepared.requestId.startsWith('nfx_'), true);
  assert.equal(prepared.responseTopic.startsWith('nofax_r_'), true);
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

test('pollRemoteResponse replays the full cached response topic for durable recovery', async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => ''
    };
  };
  await pollRemoteResponse({
    config,
    responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz123456',
    requestId: 'nfx_abcdefghijklmnopqrstuvwx',
    allowed: ['allow', 'deny'],
    fetchImpl
  });
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get('poll'), '1');
  assert.equal(parsed.searchParams.get('since'), 'all');
});

test('requestApproval bounds a hung response poll by its approval timeout', async () => {
  let published = false;
  let pollSignal;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'POST') {
      published = true;
      return { ok: true, status: 200 };
    }
    pollSignal = init.signal;
    assert.ok(pollSignal instanceof AbortSignal);
    return new Promise((_resolve, reject) => {
      if (pollSignal.aborted) {
        reject(pollSignal.reason);
        return;
      }
      pollSignal.addEventListener('abort', () => reject(pollSignal.reason), { once: true });
    });
  };

  const result = await requestApproval({
    config,
    title: 'Test',
    message: 'Approve?',
    fetchImpl,
    timeoutMs: 50,
    pollIntervalMs: 1
  });

  assert.equal(published, true);
  assert.ok(pollSignal instanceof AbortSignal);
  assert.equal(result.decision, 'timeout');
});

test('requestApproval keeps the poll deadline active while reading the response body', async () => {
  let pollSignal;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'POST') return { ok: true, status: 200 };
    pollSignal = init.signal;
    assert.ok(pollSignal instanceof AbortSignal);
    return {
      ok: true,
      status: 200,
      text: async () => new Promise((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('NOFAX_TEST_BODY_NOT_ABORTED')), 200);
        pollSignal.addEventListener('abort', () => {
          clearTimeout(guard);
          reject(pollSignal.reason);
        }, { once: true });
      })
    };
  };

  const result = await requestApproval({
    config,
    title: 'Test',
    message: 'Approve?',
    fetchImpl,
    timeoutMs: 50,
    pollIntervalMs: 1
  });

  assert.ok(pollSignal instanceof AbortSignal);
  assert.equal(result.decision, 'timeout');
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
