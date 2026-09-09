import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { buildRemoteMcpServer, REMOTE_MCP_TOOL_NAMES } from "../src/mcp";

const EXPECTED = [
  "nofax_notify",
  "nofax_request_approval",
  "nofax_request_choice",
  "nofax_request_refinement",
  "nofax_wait_for_response",
  "nofax_get_request",
  "nofax_list_pending"
] as const;

describe("remote MCP server", () => {
  it("keeps exact tool-name parity with local Nofax", () => {
    expect(REMOTE_MCP_TOOL_NAMES).toEqual(EXPECTED);
  });

  it("constructs an official MCP v2 server with injected handlers", () => {
    const handlers = {
      notify: async () => ({ status: "sent" }),
      requestApproval: async () => ({ status: "pending" }),
      requestChoice: async () => ({ status: "pending" }),
      requestRefinement: async () => ({ status: "pending" }),
      waitForResponse: async () => ({ status: "pending" }),
      getRequest: async () => ({ status: "ok", request: {} }),
      listPending: async () => ({ status: "ok", requests: [] })
    };
    expect(buildRemoteMcpServer({ handlers: handlers as never })).toBeInstanceOf(McpServer);
  });
});
