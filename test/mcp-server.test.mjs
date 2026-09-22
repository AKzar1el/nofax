import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { buildMcpServer, MCP_TOOL_NAMES } from '../src/mcp-server.mjs';

const handlers = {
  notify: async () => ({ status: 'sent' }),
  requestApproval: async () => ({ status: 'pending', requestId: 'req_123456789012345678901234', mustWait: true, instruction: 'Wait for the human.' }),
  requestChoice: async () => ({ status: 'pending', requestId: 'req_123456789012345678901234', mustWait: true, instruction: 'Wait for the human.' }),
  requestRefinement: async () => ({ status: 'pending', requestId: 'req_123456789012345678901234', mustWait: true, instruction: 'Wait for the human.' }),
  waitForResponse: async () => ({ status: 'resolved', requestId: 'req_123456789012345678901234', decision: 'allow', instruction: 'Human approved this request.' }),
  getRequest: async () => ({
    status: 'ok',
    request: {
      requestId: 'req_123456789012345678901234',
      kind: 'approval',
      status: 'pending',
      createdAt: '2026-09-22T00:00:00.000Z'
    }
  }),
  listPending: async () => ({
    status: 'ok',
    requests: [{
      requestId: 'req_123456789012345678901234',
      kind: 'choice',
      status: 'pending',
      createdAt: '2026-09-22T00:00:00.000Z'
    }]
  })
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

test('every local MCP input property explains its semantics and advertises accurate safety annotations', async () => {
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
      readOnlyHint: false,
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

test('every local MCP tool advertises an object-root output contract matching structuredContent', async () => {
  const server = buildMcpServer({ handlers });
  const args = {
    nofax_notify: { message: 'Build finished' },
    nofax_request_approval: { message: 'Deploy?' },
    nofax_request_choice: { message: 'Pick one', options: ['A'] },
    nofax_request_refinement: { message: 'Refine this draft' },
    nofax_wait_for_response: { requestId: 'req_123456789012345678901234' },
    nofax_get_request: { requestId: 'req_123456789012345678901234' },
    nofax_list_pending: {}
  };

  try {
    for (const name of MCP_TOOL_NAMES) {
      const tool = server._registeredTools[name];
      assert.ok(tool.outputSchema, `${name} must advertise an output schema`);

      const jsonSchema = z.toJSONSchema(tool.outputSchema);
      assert.equal(jsonSchema.type, 'object', `${name} output schema must keep a compatibility-safe object root`);

      const response = await tool.handler(args[name]);
      assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(response.structuredContent) }]);
      await assert.doesNotReject(
        server.validateToolOutput(tool, response, name),
        `${name} structuredContent must pass the MCP SDK's production output validator`
      );
    }

    await assert.rejects(
      server.validateToolOutput(
        server._registeredTools.nofax_notify,
        { structuredContent: { status: 'resolved' } },
        'nofax_notify'
      ),
      /Output validation error/,
      'the MCP SDK must reject structured output that violates an advertised contract'
    );
  } finally {
    await server.close();
  }
});
