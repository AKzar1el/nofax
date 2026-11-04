import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRemoteRequest, pollRemoteResponse, requestApproval, requestChoice, sendNotification } from '../src/ntfy.mjs';

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
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, undefined);
});

test('opt-in ntfy bearer token authenticates HTTPS publishing only, never approval callbacks or polling', async () => {
  const token = 'tk_synthetic_protected_topic_token_123456';
  const calls = [];
  let prepared;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ id: 'synthetic-notification' });
  };
  const remote = await createRemoteRequest({
    config,
    title: 'Approval requested',
    message: 'Synthetic approval content',
    options: ['allow', 'deny'],
    authToken: token,
    beforePublish: async (value) => { prepared = value; },
    fetchImpl
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, 'error');
  const publish = JSON.parse(calls[0].init.body);
  assert.equal(publish.topic, config.topic);
  assert.equal(publish.actions.length, 2);
  assert.ok(publish.actions.every((action) => !JSON.stringify(action).includes(token)));
  assert.equal(JSON.stringify(prepared).includes(token), false);
  assert.deepEqual(remote, prepared);

  const pollCalls = [];
  await pollRemoteResponse({
    config,
    responseTopic: remote.responseTopic,
    requestId: remote.requestId,
    allowed: remote.allowed,
    kind: 'approval',
    fetchImpl: async (url, init) => {
      pollCalls.push({ url, init });
      return new Response('', { status: 200 });
    }
  });
  assert.equal(pollCalls.length, 1);
  assert.equal(pollCalls[0].init.headers.authorization, undefined);
  assert.equal(JSON.stringify(pollCalls).includes(token), false);
});

test('NOFAX_NTFY_TOKEN environment opt-in is used without changing configuration output', async () => {
  const token = 'tk_synthetic_env_only_123456789';
  const prior = process.env.NOFAX_NTFY_TOKEN;
  process.env.NOFAX_NTFY_TOKEN = token;
  try {
    let observed;
    await sendNotification({
      config,
      title: 'Synthetic',
      message: 'Synthetic',
      fetchImpl: async (_url, init) => {
        observed = init.headers.authorization;
        return jsonResponse({ id: 'synthetic' });
      }
    });
    assert.equal(observed, `Bearer ${token}`);
    const { validateConfig } = await import('../src/config.mjs');
    assert.equal(JSON.stringify(validateConfig(config)).includes(token), false);
  } finally {
    if (prior === undefined) delete process.env.NOFAX_NTFY_TOKEN;
    else process.env.NOFAX_NTFY_TOKEN = prior;
  }
});

test('ntfy bearer authentication fails closed before publishing or persisting pending approval', async () => {
  for (const [token, server, errorCode] of [
    ['', 'https://ntfy.sh', 'NOFAX_NTFY_AUTH_TOKEN_INVALID'],
    ['invalid token with spaces', 'https://ntfy.sh', 'NOFAX_NTFY_AUTH_TOKEN_INVALID'],
    ['tk_synthetic_123456', 'http://127.0.0.1:3456', 'NOFAX_NTFY_AUTH_REQUIRES_HTTPS']
  ]) {
    let persisted = 0;
    let published = 0;
    await assert.rejects(() => createRemoteRequest({
      config: { ...config, server },
      title: 'Approval',
      message: 'Synthetic',
      options: ['allow', 'deny'],
      authToken: token,
      beforePublish: async () => { persisted += 1; },
      fetchImpl: async () => { published += 1; return jsonResponse({ id: 'synthetic' }); }
    }), (error) => error.message === errorCode && !error.message.includes(token || 'invalid token'));
    assert.equal(persisted, 0);
    assert.equal(published, 0);
  }
});

test('ntfy authenticated network errors never expose bearer credential', async () => {
  const token = 'tk_synthetic_never_print_this_123456';
  await assert.rejects(
    () => sendNotification({
      config,
      title: 'Synthetic',
      message: 'Synthetic',
      authToken: token,
      fetchImpl: async () => { throw new Error(`Request failed with Authorization: Bearer ${token}`); }
    }),
    (error) => error.deliveryState === 'ambiguous' &&
      error.message.startsWith('NOFAX_NTFY_PUBLISH_NETWORK:') &&
      !error.message.includes(token)
  );
});

test('ntfy publishing and response polling never follow 307/308 redirects', async () => {
  for (const status of [307, 308]) {
    const forwarded = [];
    const destination = createServer((req, res) => {
      forwarded.push({ method: req.method, path: req.url });
      res.writeHead(200);
      res.end('unexpected redirect destination');
    });
    await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const redirecting = createServer((_req, res) => {
      res.writeHead(status, {
        location: `http://127.0.0.1:${destination.address().port}/intercepted`
      });
      res.end();
    });
    await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    try {
      const localConfig = { ...config, server: `http://127.0.0.1:${redirecting.address().port}` };
      await assert.rejects(
        () => sendNotification({
          config: localConfig,
          title: 'Synthetic approval',
          message: 'Synthetic sensitive request',
          actions: [{ action: 'http', url: 'https://example.invalid/synthetic-response-capability' }]
        }),
        (error) => error?.message.startsWith('NOFAX_NTFY_PUBLISH_NETWORK:') &&
          error.deliveryState === 'ambiguous'
      );
      await assert.rejects(
        () => pollRemoteResponse({
          config: localConfig,
          responseTopic: 'synthetic_response_topic_capability',
          requestId: 'synthetic-request-id',
          allowed: ['allow', 'deny'],
          kind: 'approval',
          timeoutMs: 1000
        }),
        /NOFAX_NTFY_POLL_NETWORK/
      );
      assert.deepEqual(forwarded, [], `HTTP ${status} must not disclose the POST or GET to the redirect target`);
    } finally {
      await Promise.all([
        new Promise((resolve) => redirecting.close(resolve)),
        new Promise((resolve) => destination.close(resolve))
      ]);
    }
  }
});

test('ntfy polling rejects oversized event bodies before accepting a later approval', async () => {
  const requestId = 'nfx_abcdefghijklmnopqrstuvwx';
  const event = JSON.stringify({
    event: 'message',
    message: JSON.stringify({ v: 1, requestId, decision: 'allow' })
  }) + '\n';
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    start(controller) {
      const oversized = new Uint8Array(1024 * 1024 + 1).fill(0x20);
      oversized[oversized.length - 1] = 0x0a;
      controller.enqueue(oversized);
      controller.enqueue(new TextEncoder().encode(event));
      controller.close();
    },
    cancel() { cancellations += 1; }
  }));

  await assert.rejects(
    () => pollRemoteResponse({
      config, responseTopic: 'synthetic_response_topic', requestId,
      allowed: ['allow', 'deny'], kind: 'approval',
      fetchImpl: async () => response
    }),
    /NOFAX_NTFY_POLL_BODY_TOO_LARGE/
  );
  assert.equal(cancellations, 1, 'oversized response stream must be cancelled');
});

test('ntfy polling decodes UTF-8 characters split between response chunks', async () => {
  const requestId = 'nfx_abcdefghijklmnopqrstuvwx';
  const event = JSON.stringify({
    event: 'message',
    message: JSON.stringify({ v: 1, requestId, decision: 'allow', marker: '😀' })
  }) + '\n';
  const bytes = new TextEncoder().encode(event);
  const split = bytes.indexOf(0xf0) + 2;
  assert.ok(split > 2);
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    }
  }));

  const result = await pollRemoteResponse({
    config, responseTopic: 'synthetic_response_topic', requestId,
    allowed: ['allow', 'deny'], kind: 'approval',
    fetchImpl: async () => response
  });
  assert.equal(result?.decision, 'allow');
});

test('sendNotification releases an unread successful publish response body', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    cancel() { cancelled += 1; }
  }));

  await sendNotification({
    config,
    title: 'Build done',
    message: 'All tests pass',
    fetchImpl: async () => response
  });
  assert.equal(cancelled, 1);
});

test('sendNotification releases failed response bodies and treats auth refusals as not applied', async () => {
  for (const [status, deliveryState] of [
    [400, 'not_applied'],
    [401, 'not_applied'],
    [403, 'not_applied'],
    [429, 'not_applied'],
    [503, 'ambiguous']
  ]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({
      cancel() { cancelled += 1; }
    }), { status });

    await assert.rejects(
      () => sendNotification({ config, title: 'Build done', message: 'All tests pass', fetchImpl: async () => response }),
      (error) => error?.message === `NOFAX_NTFY_PUBLISH_${status}` && error.deliveryState === deliveryState
    );
    assert.equal(cancelled, 1, `HTTP ${status} must release its unread body`);
  }
});

test('sendNotification does not let response cleanup failure mask the publish result', async () => {
  for (const status of [200, 503]) {
    let cancellationAttempted = 0;
    const response = {
      ok: status === 200,
      status,
      body: { cancel: () => {
        cancellationAttempted += 1;
        return Promise.reject(new Error('synthetic cleanup failure'));
      } }
    };
    const publish = () => sendNotification({
      config,
      title: 'Build done',
      message: 'All tests pass',
      fetchImpl: async () => response
    });
    if (status === 200) await publish();
    else await assert.rejects(publish, (error) => error?.deliveryState === 'ambiguous');
    assert.equal(cancellationAttempted, 1);
  }
});

test('createRemoteRequest rejects invalid input before persisting or publishing', async () => {
  const invalidCases = [
    { title: '   ', message: 'Choose an action', publishTimeoutMs: 1000, error: /NOFAX_TITLE_REQUIRED/ },
    { title: 'Permission', message: '   ', publishTimeoutMs: 1000, error: /NOFAX_MESSAGE_REQUIRED/ },
    { title: 'Permission', message: 'Choose an action', publishTimeoutMs: 0, error: /NOFAX_PUBLISH_TIMEOUT_INVALID/ },
    { title: 'Permission', message: 'Choose an action', publishTimeoutMs: Number.NaN, error: /NOFAX_PUBLISH_TIMEOUT_INVALID/ },
    { title: 'Permission', message: 'Choose an action', publishTimeoutMs: 2_147_483_648, error: /NOFAX_PUBLISH_TIMEOUT_INVALID/ }
  ];
  for (const input of invalidCases) {
    let persisted = 0;
    let published = 0;
    await assert.rejects(() => createRemoteRequest({
      config,
      title: input.title,
      message: input.message,
      options: ['allow'],
      publishTimeoutMs: input.publishTimeoutMs,
      beforePublish: async () => { persisted += 1; },
      fetchImpl: async () => { published += 1; return jsonResponse({ id: 'unexpected' }); }
    }), input.error);
    assert.equal(persisted, 0, 'invalid request must not persist a pending approval');
    assert.equal(published, 0, 'invalid request must not publish a notification');
  }
});

test('requestApproval rejects invalid decision deadlines before sending any approval notification', async () => {
  for (const timeoutMs of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648]) {
    let published = 0;
    await assert.rejects(
      () => requestApproval({
        config,
        title: 'Permission',
        message: 'Synthetic approval',
        timeoutMs,
        fetchImpl: async () => { published += 1; return jsonResponse({ id: 'unexpected' }); }
      }),
      /NOFAX_DECISION_TIMEOUT_INVALID/
    );
    assert.equal(published, 0, 'invalid decision deadline must never publish a notification');
  }
});

test('direct ntfy publishing rejects timer overflow before contacting the server', async () => {
  for (const timeoutMs of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648]) {
    let published = 0;
    await assert.rejects(
      () => sendNotification({
        config,
        title: 'Synthetic',
        message: 'Synthetic',
        timeoutMs,
        fetchImpl: async () => { published += 1; return jsonResponse({ id: 'unexpected' }); }
      }),
      /NOFAX_PUBLISH_TIMEOUT_INVALID/
    );
    assert.equal(published, 0);
  }
});

test('standalone notification times out ambiguously even when fetch ignores abort', async () => {
  let observedSignal;
  await assert.rejects(
    () => sendNotification({
      config,
      title: 'Build done',
      message: 'All tests pass',
      timeoutMs: 20,
      fetchImpl: (_url, init) => {
        observedSignal = init.signal;
        return new Promise(() => {});
      }
    }),
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_TIMEOUT' && error.deliveryState === 'ambiguous'
  );
  assert.equal(observedSignal.aborted, true);
});

test('sendNotification releases a publish body that arrives after its timeout', async () => {
  let resolveRequest;
  let signal;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const publication = sendNotification({
    config,
    title: 'Build done',
    message: 'All tests pass',
    timeoutMs: 20,
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return pendingRequest;
    }
  });

  await assert.rejects(
    publication,
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_TIMEOUT' && error.deliveryState === 'ambiguous'
  );
  assert.equal(signal.aborted, true);

  let cancelled = 0;
  resolveRequest(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1, 'a fetch resolving after its deadline must not retain an unread body');
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


test('sendNotification retains approval context as inline ntfy UTF-8 message', async () => {
  let payload;
  await sendNotification({
    config,
    title: 'Unicode approval',
    message: '漢'.repeat(2200),
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });
  assert.ok(Buffer.byteLength(payload.message, 'utf8') <= 4096, 'ntfy inline text must not become an attachment');
  assert.match(payload.message, /…\[truncated\]$/);
  assert.ok(!payload.message.includes('\uFFFD'));
});
