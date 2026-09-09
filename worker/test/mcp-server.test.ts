import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { buildRemoteMcpServer, REMOTE_MCP_TOOL_NAMES } from "../src/mcp";

const EXPECTED = [
  "nofax_get_request",
  "nofax_list_pending"
] as const;

describe("remote MCP server", () => {
  it("exposes only the two read-only inspection tools", () => {
    expect(REMOTE_MCP_TOOL_NAMES).toEqual(EXPECTED);
  });

  it("constructs an official MCP v2 server with injected read handlers", () => {
    const handlers = {
      getRequest: async () => ({ status: "ok", request: {} }),
      listPending: async () => ({ status: "ok", requests: [] })
    };
    expect(buildRemoteMcpServer({ handlers: handlers as never })).toBeInstanceOf(McpServer);
  });
});
