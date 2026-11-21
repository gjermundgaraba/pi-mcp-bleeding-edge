import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** A server on the v1 SDK, which speaks only the 2025-era protocol. */
export const buildLegacyServer = (): McpServer => {
  const server = new McpServer({ name: "legacy-fixture", version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "Echo the text back", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text }] })
  );
  server.registerTool(
    "add-tool",
    { description: "Add a tool", inputSchema: { name: z.string() } },
    ({ name }) => {
      server.registerTool(name, { description: "Added at runtime" }, () => ({
        content: [{ type: "text", text: name }],
      }));

      return { content: [{ type: "text", text: `added ${name}` }] };
    }
  );

  return server;
};
