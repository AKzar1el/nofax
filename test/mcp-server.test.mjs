import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServer, MCP_TOOL_NAMES } from '../src/mcp-server.mjs';

test('buildMcpServer registers the complete Nofax v0.2 tool surface', async () => {
  const handlers = {
    notify: async () => ({ status: 'sent' }),
    requestApproval: async () => ({ status: 'pending' }),
    requestChoice: async () => ({ status: 'pending' }),
    requestRefinement: async () => ({ status: 'pending' }),
    waitForResponse: async () => ({ status: 'pending' }),
    getRequest: async () => ({ status: 'ok' }),
    listPending: async () => ({ status: 'ok', requests: [] })
  };
  const server = buildMcpServer({ handlers });
  assert.ok(server.server);
  assert.deepEqual(MCP_TOOL_NAMES, [
    'nofax_notify',
    'nofax_request_approval',
    'nofax_request_choice',
    'nofax_request_refinement',
    'nofax_wait_for_response',
    'nofax_get_request',
    'nofax_list_pending'
  ]);
  await server.close();
});
