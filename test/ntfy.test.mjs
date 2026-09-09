import test from 'node:test';
import assert from 'node:assert/strict';
import { requestApproval, requestChoice, sendNotification } from '../src/ntfy.mjs';

const config = { version: 1, server: 'https://ntfy.sh', topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF', timeoutSeconds: 300 };

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('sendNotification publishes bounded JSON to the configured phone topic', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ id: 'abc' });
  };
  await sendNotification({ config, title: 'Build done', message: 'All tests pass', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.topic, config.topic);
  assert.equal(payload.title, 'Build done');
  assert.equal(payload.message, 'All tests pass');
  assert.equal(payload.actions, undefined);
});

test('requestApproval publishes Allow/Deny HTTP actions and returns matching remote decision', async () => {
  const calls = [];
  let responseTopic;
  let requestId;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST' && String(url) === 'https://ntfy.sh/') {
      const payload = JSON.parse(init.body);
      assert.equal(payload.actions.length, 2);
      assert.deepEqual(payload.actions.map((a) => a.label), ['Allow', 'Deny']);
      responseTopic = new URL(payload.actions[0].url).pathname.slice(1);
      requestId = JSON.parse(payload.actions[0].body).requestId;
      assert.equal(JSON.parse(payload.actions[0].body).decision, 'allow');
      assert.equal(JSON.parse(payload.actions[1].body).decision, 'deny');
      return jsonResponse({ id: 'published' });
    }
    assert.match(String(url), new RegExp(`${responseTopic}/json`));
    return jsonResponse(`{"event":"message","message":${JSON.stringify(JSON.stringify({ v: 1, requestId, decision: 'allow' }))}}\n`);
  };

  const result = await requestApproval({ config, title: 'Permission', message: 'Run npm test?', fetchImpl, sleepImpl: async () => {} });
  assert.equal(result.decision, 'allow');
  assert.match(result.requestId, /^nfx_/);
  assert.match(result.responseTopic, /^nofax_r_/);
});

test('requestApproval ignores malformed or wrong-request replies and times out without approval', async () => {
  let now = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') return jsonResponse({ id: 'published' });
    return jsonResponse('{"event":"message","message":"{\\"v\\":1,\\"requestId\\":\\"wrong\\",\\"decision\\":\\"allow\\"}"}\n');
  };
  const result = await requestApproval({
    config,
    title: 'Permission',
    message: 'Dangerous action',
    fetchImpl,
    timeoutMs: 10,
    pollIntervalMs: 5,
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; }
  });
  assert.equal(result.decision, 'timeout');
});

test('requestChoice enforces ntfy three-action limit and returns a selected option', async () => {
  await assert.rejects(() => requestChoice({
    config,
    title: 'Pick',
    message: 'Choose',
    options: ['a', 'b', 'c', 'd'],
    fetchImpl: async () => jsonResponse({})
  }), /NOFAX_CHOICE_LIMIT/);

  let requestId;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload.actions.map((a) => a.label), ['A', 'B', 'C']);
      requestId = JSON.parse(payload.actions[1].body).requestId;
      return jsonResponse({ id: 'published' });
    }
    return jsonResponse(`{"event":"message","message":${JSON.stringify(JSON.stringify({ v: 1, requestId, decision: 'b' }))}}\n`);
  };
  const result = await requestChoice({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' }
    ],
    fetchImpl,
    sleepImpl: async () => {}
  });
  assert.equal(result.decision, 'b');
});

test('non-2xx publish fails without pretending the notification was delivered', async () => {
  await assert.rejects(() => sendNotification({
    config,
    title: 'x',
    message: 'y',
    fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429)
  }), /NOFAX_NTFY_PUBLISH_429/);
});
