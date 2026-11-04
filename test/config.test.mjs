import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initConfig, loadConfig, normalizeServer, resolveNofaxHome } from '../src/config.mjs';

test('initConfig creates and reuses a random phone topic', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = await initConfig({ home });
  const second = await initConfig({ home });
  assert.equal(first.topic, second.topic);
  assert.match(first.topic, /^nofax_[A-Za-z0-9_-]{32}$/);
  assert.equal(first.server, 'https://ntfy.sh');
  assert.equal(first.timeoutSeconds, 300);
  const disk = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(disk, first);
});

test('loadConfig rejects missing or malformed config', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'nofax-missing-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(() => loadConfig({ home }), /NOFAX_NOT_INITIALIZED/);
});

test('normalizes server and rejects credentials/query fragments', () => {
  assert.equal(normalizeServer('https://ntfy.sh/'), 'https://ntfy.sh');
  assert.throws(() => normalizeServer('ftp://ntfy.sh'), /NOFAX_SERVER_PROTOCOL/);
  assert.throws(() => normalizeServer('https://user:pass@ntfy.sh'), /NOFAX_SERVER_CREDENTIALS/);
  assert.throws(() => normalizeServer('https://ntfy.sh/?x=1'), /NOFAX_SERVER_PATH/);
});

test('requires HTTPS for non-loopback ntfy servers but preserves local development', () => {
  for (const server of ['http://localhost:8080/', 'http://127.0.0.1:8080', 'http://127.2.3.4:8080', 'http://[::1]:8080']) {
    assert.equal(normalizeServer(server), server.endsWith('/') ? server.slice(0, -1) : server);
  }
  for (const server of ['http://ntfy.sh', 'http://192.168.1.20:8080', 'http://10.0.0.1', 'http://0.0.0.0', 'http://[::ffff:127.0.0.1]', 'http://localhost.example.com']) {
    assert.throws(() => normalizeServer(server), /NOFAX_SERVER_INSECURE_HTTP/, server);
  }
  assert.equal(normalizeServer('https://ntfy.example.com'), 'https://ntfy.example.com');
});

test('NOFAX_HOME overrides default home', () => {
  assert.equal(resolveNofaxHome({ env: { NOFAX_HOME: '/tmp/nofax-custom' } }), resolve('/tmp/nofax-custom'));
});


test('ntfy topic maximum is 64 characters', async () => {
  const { validateConfig } = await import('../src/config.mjs');
  const config = { version: 1, server: 'https://ntfy.sh', topic: 'a'.repeat(64), timeoutSeconds: 300 };
  assert.equal(validateConfig(config).topic.length, 64);
  assert.throws(() => validateConfig({ ...config, topic: 'a'.repeat(65) }), /NOFAX_TOPIC_INVALID/);
});
