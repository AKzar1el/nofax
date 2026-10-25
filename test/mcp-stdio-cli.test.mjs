import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { MCP_TOOL_NAMES } from '../src/mcp-server.mjs';

test('packaged CLI entrypoint negotiates MCP over stdio and exposes the safe tool contract', { timeout: 20000 }, async () => {
  const cli = fileURLToPath(new URL('../bin/nofax.mjs', import.meta.url));
  const isolatedHome = fileURLToPath(new URL('./.nofax-stdio-smoke-unused', import.meta.url));
  const child = spawn(process.execPath, [cli, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NOFAX_HOME: isolatedHome }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();

  async function receive() {
    let timeout;
    try {
      const next = await Promise.race([
        lines.next(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('MCP stdio response timeout: ' + stderr)), 10000);
        })
      ]);
      assert.equal(next.done, false, 'server closed stdout: ' + stderr);
      return JSON.parse(next.value);
    } finally {
      clearTimeout(timeout);
    }
  }

  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  try {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'nofax-stdio-smoke', version: '1.0.0' }
      }
    });
    const initialization = await receive();
    assert.equal(initialization.id, 1);
    assert.equal(initialization.result.serverInfo.name, 'nofax');
    assert.equal(initialization.result.protocolVersion, '2025-11-25');
    assert.match(initialization.result.instructions, /Do not infer approval/);

    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
    const listing = await receive();
    assert.equal(listing.id, 2);
    assert.deepEqual(
      listing.result.tools.map((tool) => tool.name).sort(),
      [...MCP_TOOL_NAMES].sort()
    );
    const wait = listing.result.tools.find((tool) => tool.name === 'nofax_wait_for_response');
    assert.equal(wait.annotations.readOnlyHint, false);
    const notify = listing.result.tools.find((tool) => tool.name === 'nofax_notify');
    assert.match(notify.description, /never counts as approval/);
    // Discovery only: no tools/call, notifications, approvals, or network traffic.
  } finally {
    child.stdin.end();
    child.kill();
  }
});
