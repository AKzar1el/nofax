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

test('parseResponseMessage preserves refinement text beyond the summary string bound', () => {
  const text = 'r'.repeat(1200);
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.deepEqual(result, { decision: 'refine', text });
});

test('parseResponseMessage bounds refinement text at the response limit', () => {
  const text = 'r'.repeat(2200);
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine', text }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.deepEqual(result, { decision: 'refine', text: text.slice(0, 2000) });
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
