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

test('parseResponseMessage rejects refinement without text', () => {
  const result = parseResponseMessage(JSON.stringify({ v: 1, requestId: 'nfx_test', decision: 'refine' }), {
    requestId: 'nfx_test', allowed: ['refine']
  });
  assert.equal(result, null);
});
