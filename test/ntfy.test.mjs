import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteRequest, requestApproval, requestChoice, sendNotification } from '../src/ntfy.mjs';

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

test('sendNotification preserves Unicode at truncation boundaries', async () => {
  let payload;
  await sendNotification({
    config,
    title: 't'.repeat(105) + '\u{1F600}' + 'z'.repeat(30),
    message: 'm'.repeat(2185) + '\u{1F600}' + 'z'.repeat(30),
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });

  assert.equal(Buffer.from(payload.title, 'utf8').toString('utf8'), payload.title);
  assert.equal(Buffer.from(payload.message, 'utf8').toString('utf8'), payload.message);
  assert.match(payload.title, /…\[truncated\]$/);
  assert.match(payload.message, /…\[truncated\]$/);
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

test('string choice options use the same validation and bounds as object choices', async () => {
  const noFetch = async () => {
    throw new Error('unexpected fetch');
  };
  await assert.rejects(() => createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: ['   '],
    fetchImpl: noFetch
  }), /NOFAX_CHOICE_INVALID/);
  await assert.rejects(() => createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: ['x'.repeat(81)],
    fetchImpl: noFetch
  }), /NOFAX_CHOICE_INVALID/);

  const value = 'x'.repeat(40);
  let payload;
  const remote = await createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [`  ${value}  `],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });
  assert.deepEqual(remote.allowed, [value]);
  assert.equal(payload.actions[0].label, value.slice(0, 32));
  assert.equal(JSON.parse(payload.actions[0].body).decision, value);
});

test('choice labels preserve Unicode at the ntfy visible-label boundary', async () => {
  let payload;
  const label = `${'A'.repeat(31)}😀-tail`;
  await createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [{ value: 'ship', label }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });

  assert.equal(payload.actions[0].label, 'A'.repeat(31));
  assert.equal(Buffer.from(payload.actions[0].label, 'utf8').toString('utf8'), payload.actions[0].label);
});

test('choice transport rejects options that collapse to the same visible label', async () => {
  let fetchCalls = 0;
  await assert.rejects(() => createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [
      { value: 'one', label: `${'A'.repeat(32)}-one` },
      { value: 'two', label: `${'A'.repeat(32)}-two` }
    ],
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 'unexpected' });
    }
  }), /NOFAX_CHOICE_DUPLICATE/);
  assert.equal(fetchCalls, 0);
});

test('requestChoice confirms reserved option words as choices rather than approval semantics', async () => {
  let requestId;
  const published = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      published.push(payload);
      if (payload.actions) requestId = JSON.parse(payload.actions[0].body).requestId;
      return jsonResponse({ id: 'published' });
    }
    return jsonResponse(`{"event":"message","message":${JSON.stringify(JSON.stringify({ v: 1, requestId, decision: 'allow' }))}}\n`);
  };

  const result = await requestChoice({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [
      { value: 'allow', label: 'Use option A' },
      { value: 'ship', label: 'Ship' }
    ],
    fetchImpl,
    sleepImpl: async () => {}
  });

  assert.equal(result.decision, 'allow');
  assert.equal(published.length, 2);
  assert.match(published[1].title, /^Choice received/);
  assert.doesNotMatch(published[1].title, /Approved/);
});

test('requestChoice accepts refine as an ordinary choice value without refinement text', async () => {
  let requestId;
  let now = 0;
  const published = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      published.push(payload);
      if (payload.actions) requestId = JSON.parse(payload.actions[0].body).requestId;
      return jsonResponse({ id: 'published' });
    }
    return jsonResponse(`{"event":"message","message":${JSON.stringify(JSON.stringify({ v: 1, requestId, decision: 'refine' }))}}\n`);
  };

  const result = await requestChoice({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [
      { value: 'refine', label: 'Refine mode' },
      { value: 'ship', label: 'Ship' }
    ],
    fetchImpl,
    timeoutMs: 10,
    pollIntervalMs: 5,
    nowImpl: () => now,
    sleepImpl: async (ms) => { now += ms; }
  });

  assert.equal(result.decision, 'refine');
  assert.equal('text' in result, false);
  assert.equal(published.length, 2);
  assert.match(published[1].title, /^Choice received/);
  assert.equal(published[1].message, 'Nofax recorded: refine');
});

test('refinement shortcut rejects a choice that reuses its reserved refine decision', async () => {
  let fetchCalls = 0;
  await assert.rejects(() => createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose or refine',
    options: [
      { value: 'refine', label: 'Use refine mode' },
      { value: 'ship', label: 'Ship' }
    ],
    includeRefine: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 'unexpected' });
    }
  }), /NOFAX_CHOICE_DUPLICATE/);
  assert.equal(fetchCalls, 0);
});

test('refinement shortcut rejects a choice with the same visible Refine label', async () => {
  let persistCalls = 0;
  let fetchCalls = 0;
  await assert.rejects(() => createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose or refine',
    options: [
      { value: 'review', label: 'Refine' },
      { value: 'ship', label: 'Ship' }
    ],
    includeRefine: true,
    beforePublish: async () => {
      persistCalls += 1;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 'unexpected' });
    }
  }), /NOFAX_CHOICE_DUPLICATE/);
  assert.equal(persistCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('non-2xx publish fails without pretending the notification was delivered', async () => {
  await assert.rejects(
    () => sendNotification({
      config,
      title: 'x',
      message: 'y',
      fetchImpl: async () => jsonResponse({ error: 'rate limited' }, 429)
    }),
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_429' && error.deliveryState === 'not_applied'
  );
});

test('network publish failure remains delivery-ambiguous', async () => {
  await assert.rejects(
    () => sendNotification({
      config,
      title: 'x',
      message: 'y',
      fetchImpl: async () => {
        throw new Error('connection lost');
      }
    }),
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_NETWORK: connection lost' && error.deliveryState === 'ambiguous'
  );
});

test('server-side publish failure remains delivery-ambiguous', async () => {
  await assert.rejects(
    () => sendNotification({
      config,
      title: 'x',
      message: 'y',
      fetchImpl: async () => jsonResponse({ error: 'unavailable' }, 503)
    }),
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_503' && error.deliveryState === 'ambiguous'
  );
});
