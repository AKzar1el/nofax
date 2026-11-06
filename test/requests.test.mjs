import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

test('local request JSON reads accept exactly 1 MiB but reject larger projections', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const path = join(root, 'requests', `${pending.requestId}.json`);
  const base = JSON.stringify({ ...pending, padding: '' });
  const atLimit = JSON.stringify({ ...pending, padding: 'x'.repeat(1024 * 1024 - base.length) });
  assert.equal(Buffer.byteLength(atLimit), 1024 * 1024);
  await writeFile(path, atLimit, 'utf8');
  assert.deepEqual(await loadRequest({ home: root, requestId: pending.requestId }), pending);

  await writeFile(path, `${atLimit} `, 'utf8');
  await assert.rejects(loadRequest({ home: root, requestId: pending.requestId }), /NOFAX_REQUEST_FILE_TOO_LARGE/);
  await assert.rejects(discardPendingRequest({ home: root, requestId: pending.requestId }), /NOFAX_REQUEST_FILE_TOO_LARGE/);
  await assert.rejects(listPendingRequests({ home: root }), /NOFAX_REQUEST_FILE_TOO_LARGE/);
});

test('oversized terminal claims fail closed without reading the pending projection', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const terminal = join(root, 'requests', `${pending.requestId}.terminal.json`);
  const oversized = JSON.stringify({
    ...pending,
    status: 'resolved',
    decision: 'allow',
    resolvedAt: '2026-09-09T18:01:00.000Z',
    padding: 'x'.repeat(1024 * 1024)
  });
  await writeFile(terminal, oversized, 'utf8');

  await assert.rejects(loadRequest({ home: root, requestId: pending.requestId }), /NOFAX_REQUEST_TERMINAL_TOO_LARGE/);
  await assert.rejects(
    resolveRequestWithClaim({ home: root, requestId: pending.requestId, response: { decision: 'deny' } }),
    /NOFAX_REQUEST_TERMINAL_TOO_LARGE/
  );
  await assert.rejects(savePendingRequest({ home: root, request: pending }), /NOFAX_REQUEST_TERMINAL_TOO_LARGE/);
  await assert.rejects(discardPendingRequest({ home: root, requestId: pending.requestId }), /NOFAX_REQUEST_TERMINAL_TOO_LARGE/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'requests', `${pending.requestId}.json`), 'utf8')), pending);
});

test('replayed request IDs cannot overwrite a legacy resolved denial', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const historical = {
    ...pending,
    status: 'resolved',
    resolvedAt: '2026-09-09T18:01:00.000Z',
    decision: 'deny'
  };
  const path = join(root, 'requests', `${pending.requestId}.json`);
  await writeFile(path, JSON.stringify(historical), 'utf8');

  await assert.rejects(
    savePendingRequest({ home: root, request: pending }),
    /NOFAX_REQUEST_ALREADY_EXISTS/
  );
  assert.equal(JSON.parse(await readFile(path, 'utf8')).decision, 'deny');
  assert.deepEqual(await loadRequest({ home: root, requestId: pending.requestId }), historical);
});

test('replayed request IDs cannot recreate a primary file when a terminal claim exists', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  await resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'deny' } });
  const path = join(root, 'requests', `${pending.requestId}.json`);
  await unlink(path);

  await assert.rejects(
    savePendingRequest({ home: root, request: pending }),
    /NOFAX_REQUEST_ALREADY_EXISTS/
  );
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
  const stored = await loadRequest({ home: root, requestId: pending.requestId });
  assert.equal(stored.status, 'resolved');
  assert.equal(stored.decision, 'deny');
});

test('a corrupt terminal sidecar prevents a replay even without a primary file', async (t) => {
  const root = await home(t);
  const directory = join(root, 'requests');
  await mkdir(directory);
  await writeFile(join(directory, `${pending.requestId}.terminal.json`), '{corrupt', 'utf8');

  await assert.rejects(
    savePendingRequest({ home: root, request: pending }),
    /NOFAX_REQUEST_TERMINAL_INVALID_JSON/
  );
  await assert.rejects(
    readFile(join(directory, `${pending.requestId}.json`), 'utf8'),
    { code: 'ENOENT' }
  );
});

test('concurrent saves of the same request ID retain exactly one immutable record', async (t) => {
  const root = await home(t);
  const first = pending;
  const second = { ...pending, createdAt: '2026-09-09T18:01:00.000Z' };
  const outcomes = await Promise.allSettled([
    savePendingRequest({ home: root, request: first }),
    savePendingRequest({ home: root, request: second })
  ]);
  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /NOFAX_REQUEST_ALREADY_EXISTS/);
  assert.deepEqual(await loadRequest({ home: root, requestId: pending.requestId }), successes[0].value);
});

test('request filename and stored requestId must match before returning a pending request', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  await writeFile(join(root, 'requests', `${pending.requestId}.json`), JSON.stringify({
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw9'
  }), 'utf8');

  await assert.rejects(
    loadRequest({ home: root, requestId: pending.requestId }),
    /NOFAX_REQUEST_ID_MISMATCH/
  );
});

test('a terminal sidecar for another requestId cannot authorize the requested ID', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  await writeFile(join(root, 'requests', `${pending.requestId}.terminal.json`), JSON.stringify({
    ...pending,
    requestId: 'nfx_abcdefghijklmnopqrstuvw9',
    status: 'resolved',
    resolvedAt: '2026-09-09T18:01:00.000Z',
    decision: 'allow'
  }), 'utf8');

  await assert.rejects(
    loadRequest({ home: root, requestId: pending.requestId }),
    /NOFAX_REQUEST_ID_MISMATCH/
  );
  await assert.rejects(
    resolveRequestWithClaim({ home: root, requestId: pending.requestId, response: { decision: 'deny' } }),
    /NOFAX_REQUEST_ID_MISMATCH/
  );
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

test('pending list streams a large directory, preserves tie ordering and checks older corrupt files', async (t) => {
  const root = await home(t);
  const base = Date.parse('2026-09-09T18:00:00.000Z');
  const requestIdFor = (index) => `nfx_${String(index).padStart(3, '0')}${'x'.repeat(21)}`;
  for (let index = 0; index < 140; index += 1) {
    await savePendingRequest({
      home: root,
      request: {
        ...pending,
        requestId: requestIdFor(index),
        createdAt: new Date(base + Math.floor(index / 2) * 60000).toISOString()
      }
    });
  }
  await resolveRequest({ home: root, requestId: requestIdFor(139), response: { decision: 'deny' } });
  const latest = await listPendingRequests({ home: root, limit: 3 });
  assert.deepEqual(latest.map((request) => request.requestId), [138, 137, 136].map(requestIdFor));

  await writeFile(join(root, 'requests', `${requestIdFor(0)}.json`), '{invalid-json', 'utf8');
  await assert.rejects(listPendingRequests({ home: root, limit: 1 }), /NOFAX_REQUEST_INVALID_JSON/);
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
