import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponseMessage } from '../src/protocol.mjs';

test('parseResponseMessage returns a structured allow response', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'allow' }), {
    requestId: 'nfx_test', allowed: ['allow', 'deny']
  });
  assert.deepEqual(result, { decision: 'allow' });
});

test('parseResponseMessage accepts refinement text', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text: '  make it shorter  ' }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.deepEqual(result, { decision: 'refine', text: 'make it shorter' });
});

test('parseResponseMessage rejects ill-formed UTF-16 in human refinement text', () => {
  for (const surrogate of ['\ud800', '\udc00']) {
    // Escaped surrogate sequences are syntactically valid JSON but not valid text.
    const message = JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text: `before${surrogate}after` });
    assert.equal(parseResponseMessage(message, { requestId: 'nfx_test', allowed: ['refine'] }), null);
  }

  const emoji = 'Use \ud83d\udc69\u200d\ud83d\udcbb';
  const validMessage = JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text: emoji });
  assert.deepEqual(parseResponseMessage(validMessage, { requestId: 'nfx_test', allowed: ['refine'] }), {
    decision: 'refine', text: emoji
  });
});

test('parseResponseMessage preserves refinement text beyond the summary string bound', () => {
  const text = 'r'.repeat(1200);
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.deepEqual(result, { decision: 'refine', text });
});

test('parseResponseMessage bounds refinement text at the response limit', () => {
  const text = 'r'.repeat(1987) + '\u{1F600}' + 'z'.repeat(30);
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.equal(result?.decision, 'refine');
  assert.equal(result?.text.length <= 2000, true);
  assert.equal(Buffer.from(result?.text ?? '', 'utf8').toString('utf8'), result?.text);
  assert.match(result?.text ?? '', /…\[truncated\]$/);
});

test('parseResponseMessage rejects refinement without text', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine' }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.equal(result, null);
});

test('parseResponseMessage accepts refine as an ordinary choice value without text', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine' }), {
    requestId: 'nfx_test', allowed: ['refine'], kind: 'choice'
  });
  assert.deepEqual(result, { decision: 'refine' });
});

test('parseResponseMessage normalizes surrounding whitespace on an allowed decision', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: ' allow ' }), {
    requestId: 'nfx_test', allowed: ['allow', 'deny']
  });
  assert.deepEqual(result, { decision: 'allow' });
});
