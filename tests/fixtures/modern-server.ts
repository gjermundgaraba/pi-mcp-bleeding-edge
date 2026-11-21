import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Tools added at runtime with `add-tool`, shared by the instances of one server process. */
export interface FixtureState {
  readonly addedTools: string[];
}

/**
 * The test server on the v2 SDK, which serves 2026-07-28 and 2025-era clients: `echo`, `fail`,
 * `count` (with progress), `add-tool`, and the resource `notes://first`. `toolsChanged` publishes a
 * tool list change for servers whose instances are per request.
 */
export const buildModernServer = (
  state: FixtureState,
  toolsChanged: (server: McpServer) => void
): McpServer => {
  const server = new McpServer(
    { name: "fixture", version: "1.0.0" },
    { instructions: "Fixture tools for tests.\nSecond line." }
  );

  server.registerTool(
    "echo",
    {
      description: "Echo the text back",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ text }) => ({ content: [{ type: "text", text }] })
  );
  server.registerTool("fail", { description: "Always fails" }, () => ({
    content: [{ type: "text", text: "it failed" }],
    isError: true,
  }));
  server.registerTool(
    "count",
    {
      description: "Count to n with progress",
      inputSchema: z.object({ to: z.number() }),
    },
    async ({ to }, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;

      for (let step = 1; step <= to; step += 1) {
        if (token !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: step, total: to },
          });
        }
      }

      return { content: [{ type: "text", text: `counted to ${to}` }] };
    }
  );
  server.registerTool(
    "add-tool",
    {
      description: "Add a tool",
      inputSchema: z.object({ name: z.string() }),
    },
    ({ name }) => {
      state.addedTools.push(name);
      toolsChanged(server);

      return { content: [{ type: "text", text: `added ${name}` }] };
    }
  );

  for (const name of state.addedTools) {
    server.registerTool(name, { description: "Added at runtime" }, () => ({
      content: [{ type: "text", text: name }],
    }));
  }

  server.registerResource(
    "first",
    "notes://first",
    { mimeType: "text/plain", description: "The first note" },
    (uri) => ({ contents: [{ uri: uri.href, text: "hello from a resource" }] })
  );

  return server;
};
