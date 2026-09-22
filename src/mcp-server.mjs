import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createMcpToolHandlers } from './mcp-tools.mjs';

export const MCP_TOOL_NAMES = Object.freeze([
  'nofax_notify',
  'nofax_request_approval',
  'nofax_request_choice',
  'nofax_request_refinement',
  'nofax_wait_for_response',
  'nofax_get_request',
  'nofax_list_pending'
]);

const SERVER_INSTRUCTIONS = [
  'Nofax is a human-attention and approval bridge.',
  'One-way nofax_notify calls do not require waiting.',
  'Every nofax_request_* call returns a durable pending requestId.',
  'For any pending request, you MUST call nofax_wait_for_response with that requestId and repeat whenever it returns pending.',
  'Do not infer approval, continue a guarded action, claim completion, or substitute your own decision while a Nofax request is pending.',
  'Only a terminal human response authorizes the next step, and only within the authority the caller already had.',
  'If the terminal response is refine, apply the supplied refinement and request a new approval if the resulting action still requires approval.'
].join(' ');

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

const OUTPUT_REQUEST_ID = z.string().min(24).max(84).describe('Durable Nofax request handle.');

const PENDING_OUTPUT_SCHEMA = z.object({
  status: z.literal('pending').describe('The request is unresolved and must not be treated as approval.'),
  requestId: OUTPUT_REQUEST_ID,
  mustWait: z.literal(true).describe('Signals that the caller must keep waiting for a terminal human response.'),
  instruction: z.string().min(1).describe('Fail-closed next-step instruction for the caller.')
});

const WAIT_OUTPUT_SCHEMA = z.object({
  status: z.enum(['pending', 'resolved']).describe('Whether the human request is still pending or has reached a terminal response.'),
  requestId: OUTPUT_REQUEST_ID,
  mustWait: z.boolean().optional().describe('Present and true while the request remains pending.'),
  decision: z.string().min(1).max(80).optional().describe('Terminal human decision when resolved, such as allow, deny, refine, or an explicit choice value.'),
  text: z.string().min(1).max(2000).optional().describe('Human free-text refinement when the terminal decision is refine.'),
  instruction: z.string().min(1).describe('Safety-preserving instruction describing what the caller may do next.')
});

const PUBLIC_REQUEST_SCHEMA = z.object({
  requestId: OUTPUT_REQUEST_ID,
  kind: z.enum(['approval', 'choice', 'refinement']).describe('Interaction mode that created the durable request.'),
  status: z.enum(['pending', 'resolved']).describe('Current durable request state.'),
  createdAt: z.string().min(1).describe('ISO-8601 creation timestamp.'),
  resolvedAt: z.string().min(1).optional().describe('ISO-8601 terminal-response timestamp when resolved.'),
  decision: z.string().min(1).max(80).optional().describe('Terminal human decision when resolved.'),
  text: z.string().min(1).max(2000).optional().describe('Human refinement text when one was supplied.')
});

const NOTIFY_OUTPUT_SCHEMA = z.object({
  status: z.literal('sent').describe('The notification transport call completed successfully; this is never approval.')
});

const GET_REQUEST_OUTPUT_SCHEMA = z.object({
  status: z.literal('ok').describe('The durable request was read successfully.'),
  request: PUBLIC_REQUEST_SCHEMA.describe('Safe request metadata and terminal state; secret response topics are omitted.')
});

const LIST_PENDING_OUTPUT_SCHEMA = z.object({
  status: z.literal('ok').describe('The pending-request scan completed successfully.'),
  requests: z.array(PUBLIC_REQUEST_SCHEMA).describe('Bounded unresolved request projections with no secret response topics.')
});

export function buildMcpServer({ handlers = createMcpToolHandlers() } = {}) {
  const server = new McpServer(
    { name: 'nofax', version: '0.2.6' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    'nofax_notify',
    {
      title: 'Send Nofax notification',
      description: 'Send a one-way phone notification. This tool is informational and does not create a human-response wait. Notification transport success never counts as approval.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Optional notification title shown to the human; defaults to "Nofax".'),
        message: z.string().min(1).max(2200).describe('Notification body shown to the human.')
      }),
      outputSchema: NOTIFY_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.notify(args))
  );

  server.registerTool(
    'nofax_request_approval',
    {
      title: 'Request human approval',
      description: 'Send Allow/Deny to the phone and return a durable pending requestId. IMPORTANT: after this tool returns pending, call nofax_wait_for_response and repeat while it remains pending. Never continue the guarded action without a terminal Allow response. Set allowRefine when the human should also be able to send refinement text.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Optional approval prompt title shown to the human; defaults to "Nofax approval".'),
        message: z.string().min(1).max(2200).describe('Guarded action or decision context shown to the human.'),
        allowRefine: z.boolean().optional().describe('When true, also let the human return free-text refinement instead of only Allow or Deny.')
      }),
      outputSchema: PENDING_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestApproval(args))
  );

  server.registerTool(
    'nofax_request_choice',
    {
      title: 'Request human choice',
      description: 'Send up to three explicit options to the phone and return a durable pending requestId. IMPORTANT: call nofax_wait_for_response and repeat while pending; do not choose on the human\'s behalf.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Optional choice prompt title shown to the human; defaults to "Nofax choice".'),
        message: z.string().min(1).max(2200).describe('Question or decision context shown to the human.'),
        options: z.array(z.union([
          z.string().min(1).max(80).describe('String shorthand for a choice value; its first 32 characters are also used as the human-facing label.'),
          z.object({
            value: z.string().min(1).max(80).describe('Choice value returned as the terminal human decision.'),
            label: z.string().min(1).max(32).describe('Short human-facing label displayed for this choice.')
          })
        ])).min(1).max(3).describe('One to three explicit choices to present to the human.')
      }),
      outputSchema: PENDING_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestChoice(args))
  );

  server.registerTool(
    'nofax_request_refinement',
    {
      title: 'Request human refinement',
      description: 'Ask the human for free-text refinement through the configured Nofax Refine iOS Shortcut. Returns a durable pending requestId. IMPORTANT: call nofax_wait_for_response and repeat while pending.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Optional refinement prompt title shown to the human; defaults to "Nofax refinement".'),
        message: z.string().min(1).max(2200).describe('Context or draft the human should refine with free text.')
      }),
      outputSchema: PENDING_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestRefinement(args))
  );

  server.registerTool(
    'nofax_wait_for_response',
    {
      title: 'Wait for Nofax human response',
      description: 'Long-poll a durable Nofax request for up to 240 seconds. If the result is pending, you MUST call this tool again with the same requestId. Repeat indefinitely until a terminal response is returned or the user explicitly changes/cancels the goal. Do not continue the guarded action while pending.',
      inputSchema: z.object({
        requestId: z.string().min(24).max(84).describe('Durable request handle returned by a nofax_request_* tool.'),
        waitSeconds: z.number().int().min(1).max(240).optional().describe('Maximum seconds to long-poll during this call; defaults to 240. A timeout still returns pending, never approval.')
      }),
      outputSchema: WAIT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args) => result(await handlers.waitForResponse(args))
  );

  server.registerTool(
    'nofax_get_request',
    {
      title: 'Get Nofax request',
      description: 'Recover safe metadata and terminal state for a durable Nofax request. Secret response topics are never returned.',
      inputSchema: z.object({
        requestId: z.string().min(24).max(84).describe('Durable Nofax request handle to inspect without exposing its secret response topic.')
      }),
      outputSchema: GET_REQUEST_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => result(await handlers.getRequest(args))
  );

  server.registerTool(
    'nofax_list_pending',
    {
      title: 'List pending Nofax requests',
      description: 'List a bounded set of unresolved Nofax request handles for recovery after client or conversation interruption. Secret response topics are never returned.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of unresolved requests to return; defaults to 20.')
      }),
      outputSchema: LIST_PENDING_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => result(await handlers.listPending(args))
  );

  return server;
}

export async function runMcpServer() {
  await serveStdio(() => buildMcpServer());
}
