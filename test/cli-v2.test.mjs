import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.mjs';

function capture() {
  let text = '';
  return { write: (chunk) => { text += String(chunk); }, read: () => text };
}

const config = {
  version: 1,
  server: 'https://ntfy.sh',
  topic: 'nofax_abcdefghijklmnopqrstuvwxyzABCDEF',
  timeoutSeconds: 300
};

test('refine prints bounded machine-readable refinement text', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['refine', '--title', 'Draft', 'How', 'should', 'this', 'change?'], {
    stdout,
    stderr,
    loadConfigImpl: async () => config,
    requestRefinementImpl: async ({ title, message }) => {
      assert.equal(title, 'Draft');
      assert.equal(message, 'How should this change?');
      return { decision: 'refine', text: 'Make it shorter.' };
    }
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), '{"decision":"refine","text":"Make it shorter."}\n');
  assert.equal(stderr.read(), '');
});

test('refine timeout preserves timeout exit code', async () => {
  const stdout = capture();
  const code = await runCli(['refine', 'Please refine'], {
    stdout,
    stderr: capture(),
    loadConfigImpl: async () => config,
    requestRefinementImpl: async () => ({ decision: 'timeout' })
  });
  assert.equal(code, 3);
  assert.equal(stdout.read(), '{"decision":"timeout"}\n');
});

test('refine exits unsuccessfully for denied, unexpected or empty responses', async () => {
  for (const [response, expectedCode] of [
    [{ decision: 'deny' }, 2],
    [{ decision: 'unexpected' }, 1],
    [{ decision: 'refine' }, 1],
    [{ decision: 'refine', text: '' }, 1],
    [{ decision: 'refine', text: '  \t  ' }, 1]
  ]) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(['refine', 'Revise this draft'], {
      stdout,
      stderr,
      loadConfigImpl: async () => config,
      requestRefinementImpl: async () => response
    });
    assert.equal(code, expectedCode, `${JSON.stringify(response)} must not be treated as successful refinement`);
    assert.equal(stdout.read(), `${JSON.stringify(response)}\n`);
    assert.equal(stderr.read(), '');
  }
});

test('mcp starts the stdio server without ordinary stdout text', async () => {
  const stdout = capture();
  const stderr = capture();
  let started = 0;
  const code = await runCli(['mcp'], {
    stdout,
    stderr,
    runMcpServerImpl: async () => { started += 1; }
  });
  assert.equal(code, 0);
  assert.equal(started, 1);
  assert.equal(stdout.read(), '');
  assert.equal(stderr.read(), '');
});
