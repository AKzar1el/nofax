import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRemoteRequest, pollRemoteResponse, requestApproval, requestChoice, sendNotification, waitRemoteResponse } from '../src/ntfy.mjs';

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

test('direct ntfy notifications reject malformed Unicode before contacting the provider', async () => {
  for (const invalid of ['\ud800', '\udc00']) {
    for (const field of ['title', 'message']) {
      let fetchCalls = 0;
      await assert.rejects(() => sendNotification({
        config,
        title: 'Build done',
        message: 'All tests pass',
        [field]: `Human ${invalid} decision`,
        fetchImpl: async () => { fetchCalls += 1; return jsonResponse({ id: 'unexpected' }); }
      }), new RegExp(`NOFAX_${field.toUpperCase()}_INVALID_UTF8`));
      assert.equal(fetchCalls, 0, 'malformed text must not be delivered to ntfy');
    }
  }
});

test('local ntfy notifications visibly escape terminal and bidi controls', async () => {
  let payload;
  const fetchImpl = async (_url, init) => {
    payload = JSON.parse(init.body);
    return jsonResponse({ id: 'synthetic' });
  };
  await sendNotification({
    config,
    title: 'Build\u001b[2J\u202E failed',
    message: 'Status: pending\rApproved\u0000\u2066\nNext step',
    fetchImpl
  });
  assert.match(payload.title, /\\u001b/);
  assert.match(payload.title, /\\u202e/);
  assert.match(payload.message, /\\u000d/);
  assert.match(payload.message, /\\u0000/);
  assert.match(payload.message, /\\u2066/);
  assert.ok(payload.message.includes('\nNext step'));
  assert.doesNotMatch(payload.title, /[\x00-\x1f\u202a-\u202e\u2066-\u2069]/u);
  assert.doesNotMatch(payload.message, /[\x00-\x08\x0b-\x1f\u202a-\u202e\u2066-\u2069]/u);
});

test('ntfy approval titles cannot forge extra lines while message paragraphs remain readable', async () => {
  let payload;
  await sendNotification({
    config,
    title: 'Approval pending\nApproved',
    message: 'Line one\nLine two',
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Approval pending\\u000aApproved');
  assert.equal(payload.message, 'Line one\nLine two');
});

test('local ntfy notifications visibly escape Unicode line and paragraph separators', async () => {
  let payload;
  const fetchImpl = async (_url, init) => {
    payload = JSON.parse(init.body);
    return jsonResponse({ id: 'synthetic' });
  };
  await sendNotification({
    config,
    title: 'Pending\u2028Approved',
    message: 'Decision: pending\u2029Approved',
    fetchImpl
  });
  assert.ok(payload.title.includes('\\u2028'));
  assert.ok(payload.message.includes('\\u2029'));
  assert.doesNotMatch(payload.title, /\u2028/u);
  assert.doesNotMatch(payload.message, /\u2029/u);
});

test('local ntfy visibly escapes hidden format marks in messages and choice labels', async () => {
  let payload;
  const fetchImpl = async (_url, init) => {
    payload = JSON.parse(init.body);
    return jsonResponse({ id: 'synthetic' });
  };
  await createRemoteRequest({
    config,
    title: 'Allow\u200e',
    message: 'Pending\u061c\u200b\u200f\u2060\ufeff\nDeveloper 👩\u200d💻',
    options: [{ value: 'allow', label: 'Allow\u200f' }, { value: 'deny', label: 'Deny' }],
    fetchImpl
  });
  assert.ok(payload.title.includes('\\u200e'));
  for (const codePoint of ['061c', '200b', '200f', '2060', 'feff']) {
    assert.ok(payload.message.includes(`\\u${codePoint}`));
  }
  assert.equal(payload.actions[0].label, 'Allow\\u200f');
  assert.ok(payload.message.includes('\nDeveloper 👩\u200d💻'));
});

test('local ntfy exposes blank filler glyphs in titles, messages and approval labels', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Al\u3164low',
    message: 'De\u2800ny \u115f\u1160\uffa0',
    options: [{ value: 'allow', label: 'Al\u3164low' }, { value: 'deny', label: 'Deny' }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Al\\u3164low');
  assert.equal(payload.message, 'De\\u2800ny \\u115f\\u1160\\uffa0');
  assert.equal(payload.actions[0].label, 'Al\\u3164low');
});

test('local ntfy keeps emoji joiners intact beside escaped blank fillers', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Approve 👩\u200d💻\u3164',
    message: 'Review👩\u200d💻\u2800now',
    options: [{ value: 'allow', label: 'Approve 👩\u200d💻\u3164' }, { value: 'deny', label: 'Deny' }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Approve 👩\u200d💻\\u3164');
  assert.equal(payload.message, 'Review👩\u200d💻\\u2800now');
  assert.equal(payload.actions[0].label, 'Approve 👩\u200d💻\\u3164');
});

test('local ntfy action labels expose zero-width joiners while preserving message emoji', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Approval',
    message: 'Developer 👩\u200d💻',
    options: [
      { value: 'allow', label: 'Al\u200clow' },
      { value: 'deny', label: 'De\u200dny' }
    ],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.actions[0].label, 'Al\\u200clow');
  assert.equal(payload.actions[1].label, 'De\\u200dny');
  assert.equal(payload.message, 'Developer 👩\u200d💻');
});

test('local ntfy exposes word-hidden joiners in titles and messages but keeps emoji joins', async () => {
  let payload;
  await sendNotification({
    config,
    title: 'Al\u200dlow',
    message: 'De\u200cny 👩🏽\u200d💻',
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Al\\u200dlow');
  assert.equal(payload.message, 'De\\u200cny 👩🏽\u200d💻');
});

test('local ntfy shows invisible Unicode operators and grapheme joiners as escapes', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Pending\u2061approved',
    message: 'Review\u034fstatus\u2063now',
    options: [{ value: 'allow', label: 'Allow\u2064' }, { value: 'deny', label: 'Deny' }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Pending\\u2061approved');
  assert.equal(payload.message, 'Review\\u034fstatus\\u2063now');
  assert.equal(payload.actions[0].label, 'Allow\\u2064');
});

test('local ntfy exposes soft hyphen and Mongolian vowel separator in phone choices', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Approval\u00adneeded',
    message: 'Review\u180enow',
    options: [
      { value: 'first', label: 'Al\u00adlow' },
      { value: 'second', label: 'Deny' }
    ],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'synthetic' });
    }
  });
  assert.equal(payload.title, 'Approval\\u00adneeded');
  assert.equal(payload.message, 'Review\\u180enow');
  assert.equal(payload.actions[0].label, 'Al\\u00adlow');
  assert.equal(JSON.parse(payload.actions[0].body).decision, 'first');
});

test('local ntfy display escaping still enforces title and UTF-8 message bounds', async () => {
  let payload;
  const fetchImpl = async (_url, init) => {
    payload = JSON.parse(init.body);
    return jsonResponse({ id: 'synthetic' });
  };
  await sendNotification({
    config,
    title: '\u001b'.repeat(120),
    message: '\u202e'.repeat(2200),
    fetchImpl
  });
  assert.ok(payload.title.length <= 120);
  assert.ok(payload.message.length <= 2200);
  assert.ok(Buffer.byteLength(payload.message, 'utf8') <= 4096);
  assert.match(payload.message, /\\u202e/);
  assert.doesNotMatch(payload.message, /\u202e/);
});

test('unsafe cleartext ntfy servers fail before publish, approval persistence, or polling', async () => {
  const unsafe = { ...config, server: 'http://ntfy.example.invalid' };
  let networkCalls = 0;
  let persisted = 0;
  const fetchImpl = async () => { networkCalls += 1; return jsonResponse({ id: 'unexpected' }); };
  await assert.rejects(() => sendNotification({
    config: unsafe, title: 'Private notification', message: 'Synthetic', authToken: undefined, fetchImpl
  }), /NOFAX_SERVER_INSECURE_HTTP/);
  await assert.rejects(() => createRemoteRequest({
    config: unsafe,
    title: 'Private approval',
    message: 'Synthetic',
    options: ['allow', 'deny'],
    authToken: undefined,
    fetchImpl,
    beforePublish: async () => { persisted += 1; }
  }), /NOFAX_SERVER_INSECURE_HTTP/);
  await assert.rejects(() => pollRemoteResponse({
    config: unsafe,
    responseTopic: 'synthetic_response_capability',
    requestId: 'synthetic-request-id',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    fetchImpl
  }), /NOFAX_SERVER_INSECURE_HTTP/);
  assert.equal(networkCalls, 0);
  assert.equal(persisted, 0);
});

test('guessable phone topics fail before publishing or saving an approval', async () => {
  const weak = { ...config, topic: 'a'.repeat(32) };
  let published = 0;
  let persisted = 0;
  const fetchImpl = async () => { published += 1; return jsonResponse({ id: 'unexpected' }); };
  await assert.rejects(() => sendNotification({
    config: weak, title: 'Private notification', message: 'Synthetic', fetchImpl
  }), /NOFAX_TOPIC_INVALID/);
  await assert.rejects(() => createRemoteRequest({
    config: weak, title: 'Private approval', message: 'Synthetic',
    options: ['allow', 'deny'], fetchImpl,
    beforePublish: async () => { persisted += 1; }
  }), /NOFAX_TOPIC_INVALID/);
  assert.equal(published, 0);
  assert.equal(persisted, 0);
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
      error.message === 'NOFAX_NTFY_PUBLISH_NETWORK' &&
      !error.message.includes(token)
  );
});

test('anonymous ntfy network errors cannot disclose topic or approval capabilities', async () => {
  const title = 'Synthetic private approval';
  const message = 'Synthetic confidential operation details';
  const callback = 'https://ntfy.sh/private_response_capability_0123456789';
  await assert.rejects(
    () => sendNotification({
      config,
      title,
      message,
      actions: [{ action: 'http', label: 'Allow', url: callback }],
      authToken: undefined,
      fetchImpl: async () => {
        throw new Error(`POST topic=${config.topic} title=${title} message=${message} action=${callback}`);
      }
    }),
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_NETWORK' && error.deliveryState === 'ambiguous'
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
        (error) => error?.message === 'NOFAX_NTFY_PUBLISH_NETWORK' &&
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

test('ntfy polling never includes a response-topic capability in network errors', async () => {
  const responseTopic = 'nofax_r_synthetic_private_response_capability';
  const sensitiveError = `GET https://ntfy.sh/${responseTopic}/json?poll=1&since=all failed`;
  const failingFetches = [
    async () => { throw new Error(sensitiveError); },
    async () => ({ ok: true, text: async () => { throw new Error(sensitiveError); } })
  ];
  for (const fetchImpl of failingFetches) {
    await assert.rejects(() => pollRemoteResponse({
      config,
      responseTopic,
      requestId: 'synthetic-request-id',
      allowed: ['allow', 'deny'],
      kind: 'approval',
      fetchImpl
    }), (error) => error?.message === 'NOFAX_NTFY_POLL_NETWORK' &&
      !error.message.includes(responseTopic) && !error.message.includes('https://'));
  }
});

test('direct ntfy poll rejects invalid timeout hints before network access', async () => {
  let fetches = 0;
  const options = {
    config,
    responseTopic: 'synthetic_response_capability',
    requestId: 'synthetic-request-id',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse('');
    }
  };
  for (const timeoutMs of [0, -1, null, Number.NaN, Infinity, 2_147_483_648, '10']) {
    await assert.rejects(() => pollRemoteResponse({ ...options, timeoutMs }),
      /NOFAX_NTFY_POLL_TIMEOUT_INVALID/);
  }
  assert.equal(fetches, 0, 'invalid poll deadlines must never contact ntfy');
});

test('malformed UTF-8 in an ntfy poll event cannot produce an approval', async () => {
  const requestId = 'synthetic-request-id';
  const decision = JSON.stringify({ v: 1, requestId, decision: 'allow' });
  const bytes = Buffer.concat([
    Buffer.from('{"event":"message","title":"', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('","message":' + JSON.stringify(decision) + '}\n', 'utf8')
  ]);
  await assert.rejects(() => pollRemoteResponse({
    config, responseTopic: 'nofax_r_synthetic_private_response_capability',
    requestId, allowed: ['allow', 'deny'], kind: 'approval',
    fetchImpl: async () => new Response(bytes)
  }), (error) => error?.message === 'NOFAX_NTFY_POLL_NETWORK');
});

test('ntfy poll accepts multibyte UTF-8 split across stream chunks', async () => {
  const requestId = 'synthetic-request-id';
  const decision = JSON.stringify({ v: 1, requestId, decision: 'allow' });
  const bytes = Buffer.from(JSON.stringify({ event: 'message', title: 'Phone 🔐', message: decision }) + '\n');
  const split = bytes.indexOf(Buffer.from('🔐')) + 1;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    }
  });
  const result = await pollRemoteResponse({
    config, responseTopic: 'nofax_r_synthetic_private_response_capability',
    requestId, allowed: ['allow', 'deny'], kind: 'approval',
    fetchImpl: async () => new Response(body)
  });
  assert.equal(result.decision, 'allow');
});

test('ntfy polling releases unread error response bodies without changing failure status', async () => {
  for (const status of [401, 429, 503]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({
      cancel() { cancelled += 1; }
    }), { status });

    await assert.rejects(() => pollRemoteResponse({
      config,
      responseTopic: 'synthetic_response_capability',
      requestId: 'synthetic-request-id',
      allowed: ['allow', 'deny'],
      kind: 'approval',
      fetchImpl: async () => response
    }), (error) => error?.message === `NOFAX_NTFY_POLL_${status}`);
    assert.equal(cancelled, 1, `HTTP ${status} must release its unread poll body`);
  }
});

test('ntfy polling cleanup failures cannot mask an HTTP error', async () => {
  const response = {
    ok: false,
    status: 503,
    body: { cancel: () => Promise.reject(new Error('synthetic cleanup failure')) }
  };
  await assert.rejects(() => pollRemoteResponse({
    config,
    responseTopic: 'synthetic_response_capability',
    requestId: 'synthetic-request-id',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    fetchImpl: async () => response
  }), (error) => error?.message === 'NOFAX_NTFY_POLL_503');
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

test('sendNotification releases failed response bodies and classifies definitive rejections', async () => {
  for (const [status, deliveryState] of [
    [400, 'not_applied'],
    [401, 'not_applied'],
    [403, 'not_applied'],
    [413, 'not_applied'],
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

test('a null optional signal cannot disable the direct notification deadline', async () => {
  let resolveFetch;
  let observedSignal;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const publication = sendNotification({
    config,
    title: 'Build done',
    message: 'All tests pass',
    signal: null,
    timeoutMs: 20,
    fetchImpl: (_url, init) => {
      observedSignal = init.signal;
      return pendingFetch;
    }
  });

  const result = await Promise.race([
    publication.then(() => 'sent', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 100))
  ]);
  resolveFetch(jsonResponse({ id: 'synthetic' }));
  await publication.catch(() => {});

  assert.equal(result, 'NOFAX_NTFY_PUBLISH_TIMEOUT');
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

test('pollRemoteResponse releases a late response body when fetch ignores abort', async () => {
  let resolveRequest;
  let pollSignal;
  const pendingRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const poll = pollRemoteResponse({
    config,
    responseTopic: 'nofax_r_synthetic_private_response_capability',
    requestId: 'synthetic-request-id',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    timeoutMs: 20,
    fetchImpl: (_url, init) => {
      pollSignal = init.signal;
      return pendingRequest;
    }
  });

  assert.equal(await poll, null);
  assert.equal(pollSignal.aborted, true);
  let cancelled = 0;
  resolveRequest(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1, 'late polling responses must not retain an unread body');
});

test('pollRemoteResponse cancels a locked response body when reading times out', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled += 1; }
  }));
  const poll = pollRemoteResponse({
    config,
    responseTopic: 'nofax_r_synthetic_private_response_capability',
    requestId: 'synthetic-request-id',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    timeoutMs: 20,
    fetchImpl: async () => response
  });

  assert.equal(await poll, null, 'a stalled body must never mean approval');
  assert.equal(cancelled, 1, 'timed-out streams must be cancelled even when response.text() holds their reader');
  assert.equal(response.body.locked, false, 'timed-out streams must release the reader lock');
});

test('a timed-out partial poll stream cannot return a buffered approval', async () => {
  let cancelled = 0;
  const requestId = 'synthetic-request-id';
  const line = JSON.stringify({
    event: 'message',
    message: JSON.stringify({ v: 1, requestId, decision: 'allow' })
  }) + '\n';
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(line)); },
    pull() { return new Promise(() => {}); },
    cancel() { cancelled += 1; }
  }));

  const decision = await pollRemoteResponse({
    config,
    responseTopic: 'nofax_r_synthetic_private_response_capability',
    requestId,
    allowed: ['allow', 'deny'],
    kind: 'approval',
    timeoutMs: 20,
    fetchImpl: async () => response
  });
  assert.equal(decision, null, 'a timed-out stream is never a completed human decision');
  assert.equal(cancelled, 1);
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
test('requestApproval rejects invalid polling before notification publication', async () => {
  for (const pollIntervalMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    let fetchCalls = 0;
    await assert.rejects(
      () => requestApproval({
        config,
        title: 'Permission',
        message: 'Needs a human answer',
        timeoutMs: 30,
        pollIntervalMs,
        fetchImpl: async () => { fetchCalls += 1; return jsonResponse({ id: 'unexpected' }); }
      }),
      /NOFAX_POLL_INTERVAL_INVALID/
    );
    assert.equal(fetchCalls, 0, 'invalid polling cadence must never publish');
  }
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

test('standalone response polling cannot outlive its deadline after a wall-clock rollback', async () => {
  let wallTime = Date.parse('2026-01-01T12:00:00Z');
  let elapsed = 0;
  let polls = 0;
  const result = await waitRemoteResponse({
    config,
    responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz',
    requestId: 'nfx_abcdefghijklmnopqrstuvwxyz',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    timeoutMs: 1000,
    pollIntervalMs: 1000,
    nowImpl: () => wallTime,
    elapsedNowImpl: () => (elapsed += 250),
    sleepImpl: async () => {},
    fetchImpl: async () => {
      polls += 1;
      if (polls > 8) throw new Error('CLOCK_ROLLBACK_UNBOUNDED_WAIT');
      wallTime -= 60_000;
      return jsonResponse('');
    }
  });
  assert.equal(result, null, 'no human response must remain unapproved');
  assert.ok(polls > 0 && polls <= 4, 'elapsed deadline must cap the total polls');
});

test('direct response waits reject decisions arriving at or after the deadline', async () => {
  const requestId = 'nfx_abcdefghijklmnopqrstuvwxyz';
  const event = JSON.stringify({
    event: 'message',
    message: JSON.stringify({ v: 1, requestId, decision: 'allow' })
  });
  for (const deliveredAt of [9, 10, 11]) {
    let now = 0;
    const result = await waitRemoteResponse({
      config, responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz',
      requestId, allowed: ['allow', 'deny'], kind: 'approval',
      timeoutMs: 10, nowImpl: () => now,
      fetchImpl: async () => { now = deliveredAt; return jsonResponse(event + '\n'); },
      sleepImpl: async (ms) => { now += ms; }
    });
    assert.equal(result?.decision ?? null, deliveredAt < 10 ? 'allow' : null,
      'response delivered at ' + deliveredAt + ' ms must respect 10 ms deadline');
  }
});

test('direct response waits reject invalid deadlines and polling intervals before fetching', async () => {
  let fetches = 0;
  const options = {
    config,
    responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz',
    requestId: 'nfx_abcdefghijklmnopqrstuvwxyz',
    allowed: ['allow', 'deny'],
    kind: 'approval',
    fetchImpl: async () => { fetches += 1; return jsonResponse(''); }
  };
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    await assert.rejects(waitRemoteResponse({ ...options, timeoutMs }), /NOFAX_DECISION_TIMEOUT_INVALID/);
  }
  for (const pollIntervalMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    await assert.rejects(waitRemoteResponse({ ...options, timeoutMs: 2000, pollIntervalMs }), /NOFAX_POLL_INTERVAL_INVALID/);
  }
  assert.equal(fetches, 0);
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

test('ntfy rejects malformed UTF-16 choice values and labels before any side effects', async () => {
  const invalidOptions = [
    ['allow\ud800'],
    [{ value: 'allow\udc00', label: 'Allow' }],
    [{ value: 'allow', label: 'Allow\ud800' }]
  ];
  for (const options of invalidOptions) {
    let persisted = 0;
    let published = 0;
    await assert.rejects(() => createRemoteRequest({
      config,
      title: 'Pick',
      message: 'Choose',
      options,
      beforePublish: async () => { persisted += 1; },
      fetchImpl: async () => { published += 1; return jsonResponse({ id: 'unexpected' }); }
    }), /NOFAX_CHOICE_INVALID/);
    assert.equal(persisted, 0, 'malformed choice must not persist an approval');
    assert.equal(published, 0, 'malformed choice must not be sent to ntfy');
  }
});

test('choice transport rejects labels without visible content before publishing or persisting', async () => {
  let sideEffects = 0;
  for (const label of ['\u200d', '\u200e', '\u0301', `${'\u200e'.repeat(6)}Ship`]) {
    await assert.rejects(() => createRemoteRequest({
      config,
      title: 'Pick',
      message: 'Choose',
      options: [{ value: 'allow', label }],
      beforePublish: async () => { sideEffects += 1; },
      fetchImpl: async () => { sideEffects += 1; return jsonResponse({}); }
    }), /NOFAX_CHOICE_INVALID/);
  }
  assert.equal(sideEffects, 0);
});

test('choice labels may consist entirely of a visible joined emoji', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [{ value: 'developer', label: '👩‍💻' }, { value: 'developer-modified', label: '👩🏽‍💻' }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });
  assert.equal(payload.actions[0].label, '👩‍💻');
  assert.equal(payload.actions[1].label, '👩🏽‍💻');
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

test('ntfy choice action labels visibly escape control and bidi characters without changing decisions', async () => {
  let payload;
  await createRemoteRequest({
    config,
    title: 'Pick',
    message: 'Choose',
    options: [{ value: 'ship', label: 'Ship\u202e\nNow\u001b[2J' }],
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return jsonResponse({ id: 'published' });
    }
  });
  assert.equal(payload.actions[0].label, 'Ship\\u202e\\u000aNow\\u001b[2J');
  assert.equal(JSON.parse(payload.actions[0].body).decision, 'ship');
  assert.ok(payload.actions[0].label.length <= 32);
  assert.doesNotMatch(payload.actions[0].label, /[\x00-\x1f\u202a-\u202e\u2066-\u2069]/u);
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
    (error) => error?.message === 'NOFAX_NTFY_PUBLISH_NETWORK' && error.deliveryState === 'ambiguous'
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
