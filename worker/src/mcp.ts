import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { createRemoteToolHandlers, type RemoteToolHandlers } from "./mcp-tools";

export const REMOTE_MCP_TOOL_NAMES = Object.freeze([
  "nofax_notify",
  "nofax_request_approval",
  "nofax_request_choice",
  "nofax_request_refinement",
  "nofax_wait_for_response",
  "nofax_get_request",
  "nofax_list_pending"
] as const);

const SERVER_INSTRUCTIONS = [
  "Nofax is a human-attention and approval bridge.",
  "One-way nofax_notify calls do not require waiting.",
  "Every nofax_request_* call returns a durable pending requestId.",
  "For any pending request, you MUST call nofax_wait_for_response with that requestId and repeat whenever it returns pending.",
  "Do not infer approval, continue a guarded action, claim completion, or substitute your own decision while a Nofax request is pending.",
  "Only a terminal human response authorizes the next step, and only within the authority the caller already had.",
  "If the terminal response is refine, apply the supplied refinement and request a new approval if the resulting action still requires approval."
].join(" ");

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function buildRemoteMcpServer({ handlers }: { handlers: RemoteToolHandlers }): McpServer {
  const server = new McpServer(
    { name: "nofax", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "nofax_notify",
    {
      title: "Send Nofax notification",
      description: "Send a one-way phone notification. This tool is informational and does not create a human-response wait.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional(),
        message: z.string().min(1).max(2200)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.notify(args))
  );

  server.registerTool(
    "nofax_request_approval",
    {
      title: "Request human approval",
      description: "Send Allow/Deny to the phone and return a durable pending requestId. IMPORTANT: after this tool returns pending, call nofax_wait_for_response and repeat while it remains pending. Never continue the guarded action without a terminal Allow response. Set allowRefine when the human should also be able to send refinement text.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional(),
        message: z.string().min(1).max(2200),
        allowRefine: z.boolean().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestApproval(args))
  );

  server.registerTool(
    "nofax_request_choice",
    {
      title: "Request human choice",
      description: "Send up to three explicit options to the phone and return a durable pending requestId. IMPORTANT: call nofax_wait_for_response and repeat while pending; do not choose on the human's behalf.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional(),
        message: z.string().min(1).max(2200),
        options: z.array(z.union([
          z.string().min(1).max(80),
          z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(32) })
        ])).min(1).max(3)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestChoice(args))
  );

  server.registerTool(
    "nofax_request_refinement",
    {
      title: "Request human refinement",
      description: "Ask the human for free-text refinement through the Nofax mobile web form. Returns a durable pending requestId. IMPORTANT: call nofax_wait_for_response and repeat while pending.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional(),
        message: z.string().min(1).max(2200)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => result(await handlers.requestRefinement(args))
  );

  server.registerTool(
    "nofax_wait_for_response",
    {
      title: "Wait for Nofax human response",
      description: "Long-poll a durable remote Nofax request for up to 20 seconds. If the result is pending, you MUST call this tool again with the same requestId. Repeat indefinitely until a terminal response is returned or the user explicitly changes/cancels the goal. Do not continue the guarded action while pending.",
      inputSchema: z.object({
        requestId: z.string().min(24).max(84),
        waitSeconds: z.number().int().min(1).max(20).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args) => result(await handlers.waitForResponse(args))
  );

  server.registerTool(
    "nofax_get_request",
    {
      title: "Get Nofax request",
      description: "Recover safe metadata and terminal state for a durable Nofax request. Callback capabilities are never returned.",
      inputSchema: z.object({ requestId: z.string().min(24).max(84) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => result(await handlers.getRequest(args))
  );

  server.registerTool(
    "nofax_list_pending",
    {
      title: "List pending Nofax requests",
      description: "List a bounded set of unresolved Nofax request handles for recovery after client or conversation interruption. Callback capabilities are never returned.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => result(await handlers.listPending(args))
  );

  return server;
}

export function createRemoteMcpHandler(env: Env, origin: string) {
  return createMcpHandler(() =>
    buildRemoteMcpServer({ handlers: createRemoteToolHandlers(env, origin) })
  );
}
