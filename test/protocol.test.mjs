import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSummary, createRequestId, createResponseTopic, redactAndBound } from '../src/protocol.mjs';

test('request identifiers and response topics are high-entropy URL-safe values', () => {
  const id = createRequestId();
  const topic = createResponseTopic();
  assert.match(id, /^nfx_[A-Za-z0-9_-]{22,}$/);
  assert.match(topic, /^nofax_r_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(topic, createResponseTopic());
});

test('redacts secret-like keys and bounds nested values', () => {
  const cyclic = { token: 'top-secret', nested: { password: 'nope', ok: 'x'.repeat(800) } };
  cyclic.self = cyclic;
  const result = redactAndBound(cyclic);
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.nested.password, '[REDACTED]');
  assert.ok(result.nested.ok.length <= 520);
  assert.equal(result.self, '[CIRCULAR]');
});

test('buildAgentSummary is stable, bounded, and does not expose known secret keys', () => {
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'Bash',
    cwd: '/tmp/project',
    toolInput: { command: 'npm test', api_key: 'abc123' }
  });
  assert.match(summary, /Claude Code/);
  assert.match(summary, /Bash/);
  assert.match(summary, /npm test/);
  assert.doesNotMatch(summary, /abc123/);
  assert.ok(summary.length <= 2200);
});
