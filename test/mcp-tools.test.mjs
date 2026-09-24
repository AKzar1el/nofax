import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpToolHandlers, WAIT_REQUIRED } from '../src/mcp-tools.mjs';
import { createRemoteRequest } from '../src/ntfy.mjs';
import { listPendingRequests, loadRequest } from '../src/requests.mjs';

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
      const remote = {
        requestId: `nfx_abcdefghijklmnopqrstuv${String(seq).padStart(2, '0')}`,
        responseTopic: `nofax_r_abcdefghijklmnopqrstuvwxyz1234${String(seq).padStart(2, '0')}`,
        allowed: input.includeRefine
          ? (input.options.length === 2 ? [input.options[0].value, 'refine', input.options[1].value] : ['refine'])
          : input.options.map((option) => option.value)
      };
      await input.beforePublish?.(remote);
      return remote;
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

test('approval persists its durable request before remote publication continues', async (t) => {
  const home = await makeHome(t);
  let storedBeforePublish;
  const requestId = 'nfx_abcdefghijklmnopqrstuv99';
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId,
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1299',
        allowed: ['allow', 'deny']
      };
      await input.beforePublish(remote);
      storedBeforePublish = await loadRequest({ home, requestId });
      return remote;
    }
  });
  const result = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  assert.equal(result.requestId, requestId);
  assert.equal(storedBeforePublish.status, 'pending');
  assert.equal(storedBeforePublish.requestId, requestId);
});

test('authoritative ntfy publish rejection removes the durable pending residue', async (t) => {
  const home = await makeHome(t);
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: (input) => createRemoteRequest({
      ...input,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
    })
  });

  await assert.rejects(
    () => handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' }),
    /NOFAX_NTFY_PUBLISH_429/
  );
  assert.deepEqual(await listPendingRequests({ home }), []);
});

test('ambiguous ntfy network failure preserves the durable pending request', async (t) => {
  const home = await makeHome(t);
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: (input) => createRemoteRequest({
      ...input,
      fetchImpl: async () => {
        throw new Error('connection lost');
      }
    })
  });

  await assert.rejects(
    () => handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' }),
    /NOFAX_NTFY_PUBLISH_NETWORK/
  );
  const pending = await listPendingRequests({ home });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
});

test('ambiguous ntfy server failure preserves the durable pending request', async (t) => {
  const home = await makeHome(t);
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: (input) => createRemoteRequest({
      ...input,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 503 })
    })
  });

  await assert.rejects(
    () => handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' }),
    /NOFAX_NTFY_PUBLISH_503/
  );
  const pending = await listPendingRequests({ home });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
});

test('durable wait stays bound to the server and topic used when the request was published', async (t) => {
  const home = await makeHome(t);
  const originalConfig = {
    ...config,
    server: 'https://original.ntfy.example',
    topic: 'nofax_original_abcdefghijklmnopqrstuvwxyz'
  };
  const movedConfig = {
    ...config,
    server: 'https://moved.ntfy.example',
    topic: 'nofax_moved_abcdefghijklmnopqrstuvwxyz'
  };
  let configLoads = 0;
  let polledConfig;
  let confirmationConfig;
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => (configLoads++ === 0 ? originalConfig : movedConfig),
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId: 'nfx_abcdefghijklmnopqrstuv96',
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1296',
        allowed: ['allow', 'deny']
      };
      await input.beforePublish(remote);
      return remote;
    },
    pollRemoteResponseImpl: async ({ config: pollConfig }) => {
      polledConfig = pollConfig;
      return { decision: 'allow' };
    },
    sendResponseConfirmationImpl: async ({ config: confirmConfig }) => {
      confirmationConfig = confirmConfig;
    },
    nowImpl: (() => { let now = 0; return () => (now += 1000); })(),
    sleepImpl: async () => {}
  });

  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });

  assert.equal(result.decision, 'allow');
  assert.equal(polledConfig.server, originalConfig.server);
  assert.equal(polledConfig.topic, originalConfig.topic);
  assert.equal(confirmationConfig.server, originalConfig.server);
  assert.equal(confirmationConfig.topic, originalConfig.topic);
  assert.equal(configLoads, 1);
});

test('approval marks truncated title and message before remote publication', async (t) => {
  const home = await makeHome(t);
  let publishedInput;
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      publishedInput = input;
      const remote = {
        requestId: 'nfx_abcdefghijklmnopqrstuv97',
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1297',
        allowed: ['allow', 'deny']
      };
      await input.beforePublish(remote);
      return remote;
    }
  });

  await handlers.requestApproval({
    title: 't'.repeat(105) + '\u{1F600}' + 'z'.repeat(30),
    message: 'm'.repeat(2185) + '\u{1F600}' + 'z'.repeat(30)
  });

  assert.equal(publishedInput.title.length <= 120, true);
  assert.equal(publishedInput.message.length <= 2200, true);
  assert.equal(Buffer.from(publishedInput.title, 'utf8').toString('utf8'), publishedInput.title);
  assert.equal(Buffer.from(publishedInput.message, 'utf8').toString('utf8'), publishedInput.message);
  assert.match(publishedInput.title, /…\[truncated\]$/);
  assert.match(publishedInput.message, /…\[truncated\]$/);
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

test('choice handlers reject overlong decision values instead of silently truncating them', async () => {
  const handlers = createMcpToolHandlers({
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId: 'nfx_abcdefghijklmnopqrstuv98',
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1298',
        allowed: input.options.map((option) => option.value)
      };
      await input.beforePublish(remote);
      return remote;
    },
    savePendingRequestImpl: async () => {}
  });

  await assert.rejects(() => handlers.requestChoice({
    title: 'Pick one',
    message: 'Choose an explicit option',
    options: ['x'.repeat(81)]
  }), /NOFAX_CHOICE_INVALID/);

  await assert.rejects(() => handlers.requestChoice({
    title: 'Pick one',
    message: 'Choose an explicit option',
    options: [{ value: 'y'.repeat(81), label: 'Too long' }]
  }), /NOFAX_CHOICE_INVALID/);
});

test('choice handlers reject duplicate normalized decision values before transport', async () => {
  let transportCalls = 0;
  const handlers = createMcpToolHandlers({
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async () => {
      transportCalls += 1;
      throw new Error('transport should not be called');
    }
  });

  await assert.rejects(() => handlers.requestChoice({
    title: 'Pick one',
    message: 'Choose an explicit option',
    options: [
      { value: 'ship', label: 'Ship now' },
      { value: ' ship ', label: 'Ship later' }
    ]
  }), /NOFAX_CHOICE_DUPLICATE/);

  assert.equal(transportCalls, 0);
});

test('choice handlers reject options that collapse to the same visible label before transport', async () => {
  let transportCalls = 0;
  const handlers = createMcpToolHandlers({
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async () => {
      transportCalls += 1;
      throw new Error('transport should not be called');
    }
  });

  await assert.rejects(() => handlers.requestChoice({
    title: 'Pick one',
    message: 'Choose an explicit option',
    options: [
      { value: 'one', label: `${'A'.repeat(32)}-one` },
      { value: 'two', label: `${'A'.repeat(32)}-two` }
    ]
  }), /NOFAX_CHOICE_DUPLICATE/);

  assert.equal(transportCalls, 0);
});

test('choice results stay choice semantics when option values use reserved decision words', async (t) => {
  for (const decision of ['allow', 'deny', 'refine']) {
    const home = await makeHome(t);
    const handlers = makeHandlers({ home, pollResult: { decision } });
    const pending = await handlers.requestChoice({
      title: 'Pick one',
      message: 'Choose an explicit option',
      options: [
        { value: decision, label: `Choose ${decision}` },
        { value: 'ship', label: 'Ship' }
      ]
    });
    const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });

    assert.equal(result.status, 'resolved');
    assert.equal(result.decision, decision);
    assert.equal(result.instruction, 'Human choice received. Apply only that explicit choice within the caller\'s existing authority.');
    assert.equal('text' in result, false);
  }
});

test('choice wait forwards durable request kind to the response poller', async (t) => {
  const home = await makeHome(t);
  let polledKind;
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId: 'nfx_abcdefghijklmnopqrstuv66',
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1266',
        allowed: ['refine', 'ship']
      };
      await input.beforePublish(remote);
      return remote;
    },
    pollRemoteResponseImpl: async (input) => {
      polledKind = input.kind;
      return { decision: 'refine' };
    },
    sendResponseConfirmationImpl: async () => {},
    sleepImpl: async () => {}
  });

  const pending = await handlers.requestChoice({
    title: 'Pick one',
    message: 'Choose an explicit option',
    options: [
      { value: 'refine', label: 'Refine mode' },
      { value: 'ship', label: 'Ship' }
    ]
  });
  const result = await handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 });

  assert.equal(polledKind, 'choice');
  assert.equal(result.decision, 'refine');
  assert.equal(result.instruction, 'Human choice received. Apply only that explicit choice within the caller\'s existing authority.');
});

test('concurrent waits never confirm a losing terminal response', async (t) => {
  const home = await makeHome(t);
  const confirmations = [];
  let polls = 0;
  let releasePolls;
  const bothPolling = new Promise((resolve) => { releasePolls = resolve; });
  const requestId = 'nfx_abcdefghijklmnopqrstuv77';
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId,
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1277',
        allowed: ['allow', 'deny']
      };
      await input.beforePublish(remote);
      return remote;
    },
    pollRemoteResponseImpl: async () => {
      const poll = polls++;
      if (poll === 1) releasePolls();
      await bothPolling;
      return { decision: poll === 0 ? 'allow' : 'deny' };
    },
    sendResponseConfirmationImpl: async ({ response }) => {
      confirmations.push(response.decision);
    },
    sleepImpl: async () => {}
  });

  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const results = await Promise.all([
    handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 }),
    handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 })
  ]);
  const stored = await loadRequest({ home, requestId });

  assert.equal(stored.status, 'resolved');
  assert.equal(results.every((result) => result.decision === stored.decision), true);
  assert.equal(confirmations.length >= 1, true);
  assert.equal(confirmations.every((decision) => decision === stored.decision), true);
});

test('concurrent waits confirm the accepted terminal response only once', async (t) => {
  const home = await makeHome(t);
  const confirmations = [];
  let polls = 0;
  let releasePolls;
  const bothPolling = new Promise((resolve) => { releasePolls = resolve; });
  const requestId = 'nfx_abcdefghijklmnopqrstuv78';
  const handlers = createMcpToolHandlers({
    home,
    loadConfigImpl: async () => config,
    createRemoteRequestImpl: async (input) => {
      const remote = {
        requestId,
        responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz1278',
        allowed: ['allow', 'deny']
      };
      await input.beforePublish(remote);
      return remote;
    },
    pollRemoteResponseImpl: async () => {
      polls += 1;
      if (polls === 2) releasePolls();
      await bothPolling;
      return { decision: 'allow' };
    },
    sendResponseConfirmationImpl: async ({ response }) => {
      confirmations.push(response.decision);
    },
    sleepImpl: async () => {}
  });

  const pending = await handlers.requestApproval({ title: 'Deploy?', message: 'Release ready' });
  const results = await Promise.all([
    handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 }),
    handlers.waitForResponse({ requestId: pending.requestId, waitSeconds: 2 })
  ]);

  assert.equal(results.every((result) => result.decision === 'allow'), true);
  assert.deepEqual(confirmations, ['allow']);
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
