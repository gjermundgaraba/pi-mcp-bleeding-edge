import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createMcpToolName, mcpNamespace } from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";

import { serverExposure, toolExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import type { ServerEntry } from "../config/load.ts";
import type { ServerConnection } from "../connection/connection.ts";
import { createToolDefinition } from "../tools/definition.ts";
import type { McpToolDetails, ToolCaller } from "../tools/definition.ts";
import { createResourceToolDefinitions } from "../tools/resources.ts";
import type { ResourceServer } from "../tools/resources.ts";

/** What the catalog asks of the session when a tool runs. */
export interface CatalogOptions {
  /** The server's current connection for a call to `tool`, which throws when it is unavailable. */
  readonly caller: (server: string, tool: string) => Promise<ToolCaller>;
  /** Whether `read_mcp_resource` reaches the server. */
  readonly readableResources: (server: string) => boolean;
  /** The servers the resource tools reach. */
  readonly resourceServers: () => readonly ResourceServer[];
}

type Definition = ToolDefinition<TSchema, McpToolDetails>;

/**
 * The pi tools of every server. Names are `mcp__<server>__<tool>` and stay with the tool they were
 * first assigned to; tools whose names collide get hash suffixes. Pi cannot unregister tools, so
 * withdrawn tools are registered again as `hidden`.
 */
export class ToolCatalog {
  private readonly pi: ExtensionAPI;
  private readonly options: CatalogOptions;
  private readonly owners = new Map<string, string>();
  private readonly serverTools = new Map<string, ReadonlySet<string>>();
  private readonly definitions = new Map<string, Definition>();
  private resourceExposure: McpExposure | undefined;

  constructor(pi: ExtensionAPI, options: CatalogOptions) {
    this.pi = pi;
    this.options = options;
  }

  /** The server whose tool has this pi name. */
  ownerOf(toolName: string): string | undefined {
    return this.owners.get(toolName)?.split("\0", 1)[0];
  }

  /** Pi names of the tools the server currently offers. */
  toolsOf(server: string): ReadonlySet<string> {
    return this.serverTools.get(server) ?? new Set();
  }

  /** Register the tools a connection lists, and hide the ones it no longer offers. */
  register(entry: ServerEntry, connection: ServerConnection): void {
    const server = entry.name;
    const description = entry.config.description?.trim();

    const namespace = {
      name: mcpNamespace(server),
      aliases: [server],
      ...(description === undefined || description === ""
        ? {}
        : { description }),
      ...(connection.instructions === undefined
        ? {}
        : { instructions: connection.instructions }),
    };

    const previous = this.toolsOf(server);
    const current = new Set<string>();

    const plain = [...new Set(connection.tools.map((tool) => tool.name))].map(
      (tool) => createMcpToolName(server, tool)
    );

    for (const tool of connection.tools) {
      const owner = `${server}\0${tool.name}`;

      const name = createMcpToolName(server, tool.name, (candidate) => {
        const existing = this.owners.get(candidate);

        return (
          (existing !== undefined && existing !== owner) ||
          current.has(candidate) ||
          plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
        );
      });

      this.owners.set(name, owner);
      current.add(name);

      const definition = createToolDefinition({
        server,
        tool,
        name,
        exposure: toolExposure(entry.config, tool.name),
        namespace,
        caller: async () => await this.options.caller(server, tool.name),
        readableResources: () => this.options.readableResources(server),
      });

      this.definitions.set(name, definition);
      this.pi.registerTool(definition);
    }

    this.serverTools.set(server, current);

    for (const name of previous) {
      const definition = this.definitions.get(name);

      if (!current.has(name) && definition !== undefined) {
        this.pi.registerTool({ ...definition, exposure: "hidden" });
      }
    }
  }

  /** Make a server's tools unreachable, for example when it is disabled. */
  hide(server: string): void {
    for (const name of this.toolsOf(server)) {
      const definition = this.definitions.get(name);

      if (definition !== undefined) {
        this.pi.registerTool({ ...definition, exposure: "hidden" });
      }
    }

    this.serverTools.set(server, new Set());
  }

  /**
   * Register the resource tools with the widest exposure of the servers they reach (`direct`, then
   * `codemode`, then `deferred`), or hidden when no server has resources.
   */
  syncResources(servers: ReadonlyArray<{ readonly entry: ServerEntry }>): void {
    const exposures = new Set(
      servers.map((server) => serverExposure(server.entry.config))
    );

    const next =
      (["direct", "codemode", "deferred"] as const).find((exposure) =>
        exposures.has(exposure)
      ) ?? "hidden";

    if (
      next === this.resourceExposure ||
      (this.resourceExposure === undefined && next === "hidden")
    ) {
      return;
    }

    const wasDirect = this.resourceExposure === "direct";
    this.resourceExposure = next;

    const definitions = createResourceToolDefinitions({
      exposure: next,
      servers: this.options.resourceServers,
    });

    for (const definition of definitions) {
      this.pi.registerTool(definition);
    }

    if (wasDirect) {
      const names = new Set(definitions.map((definition) => definition.name));
      this.pi.setActiveTools(
        this.pi.getActiveTools().filter((name) => !names.has(name))
      );
    }
  }
}
