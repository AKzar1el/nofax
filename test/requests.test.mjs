import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardPendingRequest, savePendingRequest, loadRequest, resolveRequest, resolveRequestWithClaim, listPendingRequests } from '../src/requests.mjs';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'nofax-req-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const pending = {
  version: 1,
  requestId: 'nfx_abcdefghijklmnopqrstuvwx',
  kind: 'approval',
  responseTopic: 'nofax_r_abcdefghijklmnopqrstuvwxyz123456',
  allowed: ['allow', 'deny'],
  status: 'pending',
  createdAt: '2026-09-09T18:00:00.000Z'
};

test('pending requests persist and reload without losing the response topic', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  assert.deepEqual(await loadRequest({ home: root, requestId: pending.requestId }), pending);
  const stored = JSON.parse(await readFile(join(root, 'requests', `${pending.requestId}.json`), 'utf8'));
  assert.equal(stored.responseTopic, pending.responseTopic);
});

test('discardPendingRequest removes only unresolved pending state', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  assert.equal(await discardPendingRequest({ home: root, requestId: pending.requestId }), true);
  await assert.rejects(() => loadRequest({ home: root, requestId: pending.requestId }), /NOFAX_REQUEST_NOT_FOUND/);
  assert.equal(await discardPendingRequest({ home: root, requestId: pending.requestId }), false);
});

test('discardPendingRequest never removes a terminal winner', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  await resolveRequest({
    home: root,
    requestId: pending.requestId,
    response: { decision: 'allow' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });

  assert.equal(await discardPendingRequest({ home: root, requestId: pending.requestId }), false);
  const stored = await loadRequest({ home: root, requestId: pending.requestId });
  assert.equal(stored.status, 'resolved');
  assert.equal(stored.decision, 'allow');
});

test('pending requests preserve optional notification transport affinity', async (t) => {
  const root = await home(t);
  const request = {
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw8',
    server: 'https://ntfy.example/',
    topic: 'nofax_affinity_abcdefghijklmnopqrstuvwxyz'
  };

  const saved = await savePendingRequest({ home: root, request });
  assert.equal(saved.server, 'https://ntfy.example');
  assert.equal(saved.topic, request.topic);
  assert.deepEqual(await loadRequest({ home: root, requestId: request.requestId }), saved);

  const resolved = await resolveRequest({
    home: root,
    requestId: request.requestId,
    response: { decision: 'allow' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });
  assert.equal(resolved.server, 'https://ntfy.example');
  assert.equal(resolved.topic, request.topic);
});

test('pending request transport affinity is either complete or absent for legacy compatibility', async (t) => {
  const root = await home(t);
  await assert.rejects(
    savePendingRequest({ home: root, request: { ...pending, server: 'https://ntfy.example' } }),
    /NOFAX_REQUEST_TRANSPORT_INVALID/
  );
  await assert.rejects(
    savePendingRequest({ home: root, request: { ...pending, topic: 'nofax_affinity_abcdefghijklmnopqrstuvwxyz' } }),
    /NOFAX_REQUEST_TRANSPORT_INVALID/
  );

  await savePendingRequest({ home: root, request: pending });
  assert.deepEqual(await loadRequest({ home: root, requestId: pending.requestId }), pending);
});

test('first terminal response wins', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const first = await resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'allow' }, resolvedAt: '2026-09-09T18:01:00.000Z' });
  const second = await resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'deny' }, resolvedAt: '2026-09-09T18:02:00.000Z' });
  assert.equal(first.decision, 'allow');
  assert.equal(second.decision, 'allow');
});

test('concurrent contradictory terminal responses converge on one durable winner', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const [first, second] = await Promise.all([
    resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'allow' }, resolvedAt: '2026-09-09T18:01:00.000Z' }),
    resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'deny' }, resolvedAt: '2026-09-09T18:02:00.000Z' })
  ]);
  const stored = await loadRequest({ home: root, requestId: pending.requestId });
  assert.equal(first.decision, second.decision);
  assert.equal(stored.decision, first.decision);
  assert.equal(['allow', 'deny'].includes(stored.decision), true);
});

test('terminal claim reports exactly one winning resolver', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const [first, second] = await Promise.all([
    resolveRequestWithClaim({ home: root, requestId: pending.requestId, response: { decision: 'allow' }, resolvedAt: '2026-09-09T18:01:00.000Z' }),
    resolveRequestWithClaim({ home: root, requestId: pending.requestId, response: { decision: 'allow' }, resolvedAt: '2026-09-09T18:02:00.000Z' })
  ]);

  assert.equal(Number(first.claimed) + Number(second.claimed), 1);
  assert.equal(first.request.decision, 'allow');
  assert.equal(second.request.decision, 'allow');
});

test('non-choice refine terminal responses require refinement text', async (t) => {
  const root = await home(t);
  const refinementPending = {
    ...pending,
    kind: 'refinement',
    allowed: ['refine']
  };
  await savePendingRequest({ home: root, request: refinementPending });

  await assert.rejects(
    resolveRequest({
      home: root,
      requestId: refinementPending.requestId,
      response: { decision: 'refine' },
      resolvedAt: '2026-09-09T18:01:00.000Z'
    }),
    /NOFAX_REQUEST_TEXT_INVALID/
  );

  const choicePending = {
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvwy',
    kind: 'choice',
    allowed: ['refine']
  };
  await savePendingRequest({ home: root, request: choicePending });
  const choice = await resolveRequest({
    home: root,
    requestId: choicePending.requestId,
    response: { decision: 'refine' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });
  assert.equal(choice.decision, 'refine');
  assert.equal('text' in choice, false);
});

test('direct refinement resolution visibly marks bounded text', async (t) => {
  const root = await home(t);
  const refinementPending = {
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw7',
    kind: 'refinement',
    allowed: ['refine']
  };
  await savePendingRequest({ home: root, request: refinementPending });

  const result = await resolveRequest({
    home: root,
    requestId: refinementPending.requestId,
    response: { decision: 'refine', text: 'x'.repeat(1987) + '\u{1F600}' + 'z'.repeat(30) },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });

  assert.equal(result.text.length <= 2000, true);
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
  assert.match(result.text, /…\[truncated\]$/);
});

test('terminal resolution keeps the original projection pending and persists the sidecar winner', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const result = await resolveRequest({
    home: root,
    requestId: pending.requestId,
    response: { decision: 'allow' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });

  const projection = JSON.parse(await readFile(join(root, 'requests', `${pending.requestId}.json`), 'utf8'));
  const terminal = JSON.parse(await readFile(join(root, 'requests', `${pending.requestId}.terminal.json`), 'utf8'));
  assert.equal(projection.status, 'pending');
  assert.equal(terminal.status, 'resolved');
  assert.equal(terminal.decision, 'allow');
  assert.equal(result.decision, 'allow');
  assert.equal((await loadRequest({ home: root, requestId: pending.requestId })).decision, 'allow');
});

test('historical resolved main files still load when no terminal sidecar exists', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const historical = {
    ...pending,
    status: 'resolved',
    resolvedAt: '2026-09-09T18:01:00.000Z',
    decision: 'deny'
  };
  await writeFile(
    join(root, 'requests', `${pending.requestId}.json`),
    `${JSON.stringify(historical, null, 2)}\n`,
    'utf8'
  );
  assert.equal((await loadRequest({ home: root, requestId: pending.requestId })).decision, 'deny');
});

test('terminal claim remains authoritative if the main request projection is still pending', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const terminal = {
    ...pending,
    status: 'resolved',
    resolvedAt: '2026-09-09T18:01:00.000Z',
    decision: 'deny'
  };
  await writeFile(
    join(root, 'requests', `${pending.requestId}.terminal.json`),
    `${JSON.stringify(terminal, null, 2)}\n`,
    'utf8'
  );

  const loaded = await loadRequest({ home: root, requestId: pending.requestId });
  assert.equal(loaded.status, 'resolved');
  assert.equal(loaded.decision, 'deny');
  assert.deepEqual(await listPendingRequests({ home: root }), []);
});

test('pending list is bounded and excludes resolved requests', async (t) => {
  const root = await home(t);
  for (let i = 0; i < 3; i += 1) {
    await savePendingRequest({ home: root, request: { ...pending, requestId: `nfx_abcdefghijklmnopqrstuvw${i}` } });
  }
  await resolveRequest({ home: root, requestId: 'nfx_abcdefghijklmnopqrstuvw0', response: { decision: 'deny' }, resolvedAt: '2026-09-09T18:02:00.000Z' });
  const list = await listPendingRequests({ home: root, limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending');
});

test('pending list keeps the newest requests when the bounded limit is reached', async (t) => {
  const root = await home(t);
  const olderIds = [];
  for (let i = 0; i < 20; i += 1) {
    const requestId = `nfx_z${String(i).padStart(2, '0')}${'x'.repeat(21)}`;
    olderIds.push(requestId);
    await savePendingRequest({
      home: root,
      request: {
        ...pending,
        requestId,
        createdAt: `2026-09-09T18:${String(i).padStart(2, '0')}:00.000Z`
      }
    });
  }
  const newestId = `nfx_A00${'y'.repeat(21)}`;
  await savePendingRequest({
    home: root,
    request: { ...pending, requestId: newestId, createdAt: '2026-09-09T19:00:00.000Z' }
  });

  const list = await listPendingRequests({ home: root, limit: 20 });
  assert.equal(list.length, 20);
  assert.equal(list[0].requestId, newestId);
  assert.equal(list.some((request) => request.requestId === newestId), true);
  assert.equal(list.some((request) => request.requestId === olderIds[0]), false);
});

test('pending list fails closed when a valid request file is corrupted', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  await writeFile(
    join(root, 'requests', `${pending.requestId}.json`),
    '{not-json\n',
    'utf8'
  );

  await assert.rejects(
    listPendingRequests({ home: root }),
    /NOFAX_REQUEST_INVALID_JSON/
  );
});

test('durable allowed values reject whitespace-only decisions', async (t) => {
  const root = await home(t);
  await assert.rejects(
    savePendingRequest({
      home: root,
      request: { ...pending, allowed: ['   '] }
    }),
    /NOFAX_REQUEST_ALLOWED_INVALID/
  );
});

test('durable allowed values reject duplicates after normalization', async (t) => {
  const root = await home(t);
  await assert.rejects(
    savePendingRequest({
      home: root,
      request: { ...pending, kind: 'choice', allowed: ['ship', ' ship '] }
    }),
    /NOFAX_REQUEST_ALLOWED_INVALID/
  );
});

test('durable allowed values normalize surrounding whitespace before persistence and resolution', async (t) => {
  const root = await home(t);
  const request = {
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw9',
    kind: 'choice',
    allowed: [' allow ', ' deny ']
  };

  const saved = await savePendingRequest({ home: root, request });
  assert.deepEqual(saved.allowed, ['allow', 'deny']);
  assert.deepEqual((await loadRequest({ home: root, requestId: request.requestId })).allowed, ['allow', 'deny']);

  const resolved = await resolveRequest({
    home: root,
    requestId: request.requestId,
    response: { decision: 'allow' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });
  assert.equal(resolved.decision, 'allow');
});

test('direct terminal responses normalize surrounding whitespace before allowed-value matching', async (t) => {
  const root = await home(t);
  const request = {
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw8',
    kind: 'choice'
  };
  await savePendingRequest({ home: root, request });

  const resolved = await resolveRequest({
    home: root,
    requestId: request.requestId,
    response: { decision: ' allow ' },
    resolvedAt: '2026-09-09T18:01:00.000Z'
  });

  assert.equal(resolved.decision, 'allow');
});
