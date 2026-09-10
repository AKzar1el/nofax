import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { createRemoteToolHandlers, type RemoteToolHandlers } from "./mcp-tools";

export const REMOTE_MCP_TOOL_NAMES = Object.freeze([
  "nofax_notify",
  "nofax_get_request",
  "nofax_list_pending"
] as const);

const SERVER_INSTRUCTIONS = [
  "Nofax remote mode can send one-way phone notifications and inspect durable request metadata.",
  "nofax_notify is informational only and does not create a human-response wait.",
  "The remaining remote tools are read-only inspection operations.",
  "Remote mode cannot create approvals or choices, request refinements, wait for human responses, resolve requests, or accept callback/webhook mutations."
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
    "nofax_get_request",
    {
      title: "Get Nofax request",
      description: "Read safe metadata and terminal state for an existing durable Nofax request. Callback capabilities are never returned.",
      inputSchema: z.object({ requestId: z.string().min(24).max(84) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => result(await handlers.getRequest(args))
  );

  server.registerTool(
    "nofax_list_pending",
    {
      title: "List pending Nofax requests",
      description: "Read a bounded list of unresolved, unexpired Nofax request handles. Callback capabilities are never returned.",
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
