import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePendingRequest, loadRequest, resolveRequest, listPendingRequests } from '../src/requests.mjs';

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

test('first terminal response wins', async (t) => {
  const root = await home(t);
  await savePendingRequest({ home: root, request: pending });
  const first = await resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'allow' }, resolvedAt: '2026-09-09T18:01:00.000Z' });
  const second = await resolveRequest({ home: root, requestId: pending.requestId, response: { decision: 'deny' }, resolvedAt: '2026-09-09T18:02:00.000Z' });
  assert.equal(first.decision, 'allow');
  assert.equal(second.decision, 'allow');
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
