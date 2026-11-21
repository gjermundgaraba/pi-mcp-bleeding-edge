import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  completeMcpCommand,
  MCP_COMMAND_DESCRIPTION,
  runMcpCommand,
} from "./manager/command.ts";
import { McpSession } from "./session/controller.ts";
import type { McpSessionOptions } from "./session/controller.ts";
import { renderUnregisteredMcpTool } from "./tools/render.ts";

export type { McpSessionOptions } from "./session/controller.ts";

/**
 * MCP for pi on the official MCP TypeScript SDK, speaking protocol 2026-07-28 and falling back to
 * 2025-era servers. Registering `/mcp` replaces pi's built-in MCP support.
 */
export const createMcpExtension =
  (options: McpSessionOptions = {}): ExtensionFactory =>
  (pi: ExtensionAPI): void => {
    const session = new McpSession(pi, options);

    pi.registerToolRenderer(renderUnregisteredMcpTool);

    pi.on("session_start", (_event, ctx) => {
      session.start(ctx);
    });
    pi.on("before_agent_start", async (event, ctx) => {
      await session.beforeAgentStart(event, ctx);
    });
    pi.on("tool_call", async (event, ctx) => {
      await session.beforeToolCall(event, ctx);
    });
    pi.on("turn_start", async (_event, ctx) => {
      await session.pickUpSignIns(ctx);
    });
    pi.on("mcp_servers_change", async (_event, ctx) => {
      await session.syncRegisteredServers(ctx);
    });
    pi.on("session_shutdown", async () => {
      await session.shutdown();
    });

    pi.registerCommand("mcp", {
      description: MCP_COMMAND_DESCRIPTION,
      getArgumentCompletions: (prefix) => completeMcpCommand(session, prefix),
      handler: async (args, ctx) => {
        await runMcpCommand(session, args, ctx);
      },
    });
  };

export default createMcpExtension();
