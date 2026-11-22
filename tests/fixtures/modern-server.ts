import { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredTool } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Tools added and removed at runtime, shared by the instances of one server process. */
export interface FixtureState {
  readonly addedTools: string[];
  readonly removedTools: string[];
}

export const fixtureState = (): FixtureState => ({
  addedTools: [],
  removedTools: [],
});

/**
 * The test server on the v2 SDK, which serves 2026-07-28 and 2025-era clients: `echo`, `fail`,
 * `count` (with progress), `dash-name` and `dash_name` (whose pi names collide), `add-tool`,
 * `remove-tool`, and the resource `notes://first`. Adding and removing a tool changes this instance,
 * which notifies its own client, and `state` for later instances; `toolsChanged` publishes the change
 * for servers whose instances are per request.
 */
export const buildModernServer = (
  state: FixtureState,
  toolsChanged: () => void
): McpServer => {
  const server = new McpServer(
    { name: "fixture", version: "1.0.0" },
    { instructions: "Fixture tools for tests.\nSecond line." }
  );

  const tools = new Map<string, RegisteredTool>();

  const register = (name: string, tool: () => RegisteredTool): void => {
    if (!state.removedTools.includes(name)) {
      tools.set(name, tool());
    }
  };

  register("echo", () =>
    server.registerTool(
      "echo",
      {
        description: "Echo the text back",
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
      },
      ({ text }) => ({ content: [{ type: "text", text }] })
    )
  );
  register("fail", () =>
    server.registerTool("fail", { description: "Always fails" }, () => ({
      content: [{ type: "text", text: "it failed" }],
      isError: true,
    }))
  );
  register("count", () =>
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
    )
  );

  for (const name of ["dash-name", "dash_name"]) {
    register(name, () =>
      server.registerTool(name, { description: `The tool ${name}` }, () => ({
        content: [{ type: "text", text: name }],
      }))
    );
  }

  const addTool = (name: string): void => {
    register(name, () =>
      server.registerTool(name, { description: "Added at runtime" }, () => ({
        content: [{ type: "text", text: name }],
      }))
    );
  };

  server.registerTool(
    "add-tool",
    { description: "Add a tool", inputSchema: z.object({ name: z.string() }) },
    ({ name }) => {
      state.addedTools.push(name);
      addTool(name);
      toolsChanged();

      return { content: [{ type: "text", text: `added ${name}` }] };
    }
  );
  server.registerTool(
    "remove-tool",
    {
      description: "Remove a tool",
      inputSchema: z.object({ name: z.string() }),
    },
    ({ name }) => {
      state.removedTools.push(name);
      tools.get(name)?.remove();
      toolsChanged();

      return { content: [{ type: "text", text: `removed ${name}` }] };
    }
  );

  for (const name of state.addedTools) {
    addTool(name);
  }

  server.registerResource(
    "first",
    "notes://first",
    { mimeType: "text/plain", description: "The first note" },
    (uri) => ({ contents: [{ uri: uri.href, text: "hello from a resource" }] })
  );

  return server;
};
