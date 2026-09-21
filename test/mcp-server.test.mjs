import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { buildMcpServer, MCP_TOOL_NAMES } from '../src/mcp-server.mjs';

const handlers = {
  notify: async () => ({ status: 'sent' }),
  requestApproval: async () => ({ status: 'pending' }),
  requestChoice: async () => ({ status: 'pending' }),
  requestRefinement: async () => ({ status: 'pending' }),
  waitForResponse: async () => ({ status: 'pending' }),
  getRequest: async () => ({ status: 'ok' }),
  listPending: async () => ({ status: 'ok', requests: [] })
};

function assertPropertyDescriptions(schema, path = 'input') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.match(property.description ?? '', /\S/, `${path}.${name} must advertise a semantic description`);
      assertPropertyDescriptions(property, `${path}.${name}`);
    }
  }
  if (schema.items) assertPropertyDescriptions(schema.items, `${path}[]`);
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((branch, index) => assertPropertyDescriptions(branch, `${path}.${keyword}[${index}]`));
    }
  }
}

test('buildMcpServer registers the complete Nofax v0.2 tool surface', async () => {
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

test('every local MCP input property explains its semantics without changing safety annotations', async () => {
  const server = buildMcpServer({ handlers });
  try {
    for (const name of MCP_TOOL_NAMES) {
      const tool = server._registeredTools[name];
      assert.ok(tool, `${name} must remain registered`);
      assertPropertyDescriptions(z.toJSONSchema(tool.inputSchema), name);
    }

    assert.deepEqual(server._registeredTools.nofax_notify.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    assert.deepEqual(server._registeredTools.nofax_wait_for_response.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
    assert.deepEqual(server._registeredTools.nofax_list_pending.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  } finally {
    await server.close();
  }
});
