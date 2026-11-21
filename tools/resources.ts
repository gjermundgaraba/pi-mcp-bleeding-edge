import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ContentBlock,
  ListResourcesResult,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

import { toPiExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import type {
  CallOptions,
  ResourceTemplate,
} from "../connection/connection.ts";
import {
  limitContent,
  READ_MCP_RESOURCE_TOOL,
  toJsonValue,
  toModelContent,
} from "./content.ts";
import type { McpToolDetails } from "./definition.ts";

export { READ_MCP_RESOURCE_TOOL } from "./content.ts";

const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";

/** Names of the resource tools, which reach every server with resources. */
export const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_MCP_RESOURCES_TOOL,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  READ_MCP_RESOURCE_TOOL,
]);

/** A connected server that offers resources. */
export interface ResourceServer {
  readonly name: string;
  readonly resourcesPage: (
    cursor: string | undefined,
    options: CallOptions
  ) => Promise<ListResourcesResult>;
  readonly resourceTemplatesPage: (
    cursor: string | undefined,
    options: CallOptions
  ) => Promise<{
    resourceTemplates: ResourceTemplate[];
    nextCursor?: string | undefined;
  }>;
  readonly allResources: (options: CallOptions) => Promise<Resource[]>;
  readonly allResourceTemplates: (
    options: CallOptions
  ) => Promise<ResourceTemplate[]>;
  readonly readResource: (
    uri: string,
    options: CallOptions
  ) => Promise<ReadResourceResult>;
}

/** A resource or template as listed: `uri` or `uriTemplate`, and decorations the listings drop. */
interface ListedItem {
  readonly uri?: string;
  readonly uriTemplate?: string;
  readonly mimeType?: string | undefined;
  readonly _meta?: unknown;
  readonly icons?: unknown;
}

const MCP_APP_PROFILE = /;\s*profile\s*=\s*"?mcp-app"?/iu;

/** MCP App user interfaces, which only hosts that render them can use. */
const isMcpAppResource = (item: ListedItem): boolean => {
  const uri = item.uri ?? item.uriTemplate ?? "";

  return uri.startsWith("ui://") || MCP_APP_PROFILE.test(item.mimeType ?? "");
};

const listed = <T extends ListedItem>(
  server: string,
  item: T
): Omit<T, "_meta" | "icons"> & { readonly server: string } => {
  const { _meta: _ignored, icons: _icons, ...rest } = item;

  return { server, ...rest };
};

const LIST_PARAMETERS = Type.Object(
  {
    server: Type.Optional(
      Type.String({
        description:
          "MCP server name. Omit to list every server with resources.",
      })
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          "Opaque cursor from a previous call with the same server; omit for the first page.",
      })
    ),
  },
  { additionalProperties: false }
);

const READ_PARAMETERS = Type.Object(
  {
    server: Type.String({
      description:
        "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
    }),
    uri: Type.String({
      description:
        "Resource URI to read. Must be one of the URIs returned by list_mcp_resources.",
    }),
  },
  { additionalProperties: false }
);

type ListParameters = Static<typeof LIST_PARAMETERS>;

const optionalString = { type: "string" };

const LISTING_ERRORS = {
  type: "array",
  description: "Servers that could not be listed",
  items: {
    type: "object",
    properties: { server: { type: "string" }, error: { type: "string" } },
    required: ["server", "error"],
  },
};

const listOutputSchema = (
  key: string,
  properties: TSchema,
  required: readonly string[]
): TSchema => ({
  type: "object",
  properties: {
    server: optionalString,
    [key]: { type: "array", items: { type: "object", properties, required } },
    nextCursor: optionalString,
    errors: LISTING_ERRORS,
  },
  required: [key],
});

const LIST_OUTPUT_SCHEMA = listOutputSchema(
  "resources",
  {
    server: { type: "string" },
    uri: { type: "string" },
    name: { type: "string" },
    title: optionalString,
    description: optionalString,
    mimeType: optionalString,
    size: { type: "number" },
  },
  ["server", "uri", "name"]
);

const LIST_TEMPLATES_OUTPUT_SCHEMA = listOutputSchema(
  "resourceTemplates",
  {
    server: { type: "string" },
    uriTemplate: { type: "string", description: "RFC 6570 URI template" },
    name: { type: "string" },
    title: optionalString,
    description: optionalString,
    mimeType: optionalString,
  },
  ["server", "uriTemplate", "name"]
);

const READ_OUTPUT_SCHEMA: TSchema = {
  type: "object",
  properties: {
    server: { type: "string" },
    uri: { type: "string" },
    contents: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              uri: { type: "string" },
              mimeType: optionalString,
              text: { type: "string" },
            },
            required: ["uri", "text"],
          },
          {
            type: "object",
            properties: {
              uri: { type: "string" },
              mimeType: optionalString,
              blob: { type: "string", description: "base64" },
            },
            required: ["uri", "blob"],
          },
        ],
      },
    },
  },
  required: ["server", "uri", "contents"],
};

/** A blank argument counts as omitted. */
const given = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";

  return trimmed === "" ? undefined : trimmed;
};

const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

const jsonResult = async (
  tool: string,
  server: string | undefined,
  payload: JsonValue
): Promise<AgentToolResult<McpToolDetails>> => {
  const { content, fullOutputPath } = await limitContent([
    { type: "text", text: JSON.stringify(payload) },
  ]);

  return {
    content,
    details: {
      server: server ?? "",
      tool,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
    structuredContent: payload,
  };
};

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

/** How one of the two listing tools lists. */
interface Listing<T extends ListedItem> {
  readonly key: "resources" | "resourceTemplates";
  readonly page: (
    server: ResourceServer,
    cursor: string | undefined,
    options: CallOptions
  ) => Promise<Page<T>>;
  readonly all: (server: ResourceServer, options: CallOptions) => Promise<T[]>;
}

const RESOURCES: Listing<Resource> = {
  key: "resources",
  page: async (server, cursor, options) => {
    const result = await server.resourcesPage(cursor, options);

    return { items: result.resources, nextCursor: result.nextCursor };
  },
  all: async (server, options) => await server.allResources(options),
};

const TEMPLATES: Listing<ResourceTemplate> = {
  key: "resourceTemplates",
  page: async (server, cursor, options) => {
    const result = await server.resourceTemplatesPage(cursor, options);

    return { items: result.resourceTemplates, nextCursor: result.nextCursor };
  },
  all: async (server, options) => await server.allResourceTemplates(options),
};

/**
 * The three resource tools Codex and opencode use, so models trained on them use them unchanged.
 * Listings are JSON: one page of one server, or every page of every server. MCP App resources and
 * icons are left out. `servers` returns the servers they reach when a call runs.
 */
export const createResourceToolDefinitions = (options: {
  readonly exposure: McpExposure;
  readonly servers: () => readonly ResourceServer[];
}): Array<ToolDefinition<TSchema, McpToolDetails>> => {
  const exposure = toPiExposure(options.exposure);
  const annotations = { readOnlyHint: true };

  const findServer = (name: string): ResourceServer => {
    const servers = options.servers();
    const server = servers.find((candidate) => candidate.name === name);

    if (server !== undefined) {
      return server;
    }

    const available = servers.map((candidate) => candidate.name).join(", ");

    const hint =
      available === "" ? "" : `. Servers with resources: ${available}`;

    throw new Error(`MCP server "${name}" has no resources${hint}`);
  };

  const listAll = async <T extends ListedItem>(
    signal: AbortSignal | undefined,
    listing: Listing<T>
  ): Promise<JsonValue> => {
    const servers = options
      .servers()
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const results = await Promise.allSettled(
      servers.map(async (server) => await listing.all(server, { signal }))
    );

    const items: object[] = [];
    const errors: Array<{ server: string; error: string }> = [];

    for (const [index, result] of results.entries()) {
      const server = servers[index]?.name ?? "";

      if (result.status === "fulfilled") {
        items.push(
          ...result.value
            .filter((item) => !isMcpAppResource(item))
            .map((item) => listed(server, item))
        );
      } else {
        errors.push({ server, error: errorText(result.reason) });
      }
    }

    return toJsonValue({
      [listing.key]: items,
      ...(errors.length > 0 ? { errors } : {}),
    });
  };

  const list = async <T extends ListedItem>(
    params: ListParameters,
    signal: AbortSignal | undefined,
    listing: Listing<T>
  ): Promise<JsonValue> => {
    const serverName = given(params.server);
    const cursor = given(params.cursor);

    if (serverName === undefined) {
      if (cursor !== undefined) {
        throw new Error("cursor can only be used when a server is specified");
      }

      return await listAll(signal, listing);
    }

    const server = findServer(serverName);
    const page = await listing.page(server, cursor, { signal });

    return toJsonValue({
      server: server.name,
      [listing.key]: page.items
        .filter((item) => !isMcpAppResource(item))
        .map((item) => listed(server.name, item)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  };

  const listResources: ToolDefinition<typeof LIST_PARAMETERS, McpToolDetails> =
    {
      name: LIST_MCP_RESOURCES_TOOL,
      label: LIST_MCP_RESOURCES_TOOL,
      description:
        "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
      parameters: LIST_PARAMETERS,
      outputSchema: LIST_OUTPUT_SCHEMA,
      exposure,
      annotations,
      execute: async (_id, params, signal) =>
        await jsonResult(
          LIST_MCP_RESOURCES_TOOL,
          given(params.server),
          await list(params, signal, RESOURCES)
        ),
    };

  const listTemplates: ToolDefinition<typeof LIST_PARAMETERS, McpToolDetails> =
    {
      name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
      label: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
      description:
        "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
      parameters: LIST_PARAMETERS,
      outputSchema: LIST_TEMPLATES_OUTPUT_SCHEMA,
      exposure,
      annotations,
      execute: async (_id, params, signal) =>
        await jsonResult(
          LIST_MCP_RESOURCE_TEMPLATES_TOOL,
          given(params.server),
          await list(params, signal, TEMPLATES)
        ),
    };

  const readResource: ToolDefinition<typeof READ_PARAMETERS, McpToolDetails> = {
    name: READ_MCP_RESOURCE_TOOL,
    label: READ_MCP_RESOURCE_TOOL,
    description:
      "Read a specific resource from an MCP server given the server name and resource URI.",
    parameters: READ_PARAMETERS,
    outputSchema: READ_OUTPUT_SCHEMA,
    exposure,
    annotations,
    async execute(_id, params, signal) {
      const serverName = given(params.server);
      const uri = given(params.uri);

      if (serverName === undefined) {
        throw new Error("server must be provided");
      }

      if (uri === undefined) {
        throw new Error("uri must be provided");
      }

      const server = findServer(serverName);
      const result = await server.readResource(uri, { signal });
      const labeled = result.contents.length > 1;

      const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
        ...(labeled
          ? [{ type: "text" as const, text: `${contents.uri}:` }]
          : []),
        { type: "resource" as const, resource: contents },
      ]);

      const converted = await toModelContent(server.name, blocks);

      const { content, fullOutputPath } = await limitContent(
        converted.length > 0
          ? converted
          : [{ type: "text", text: `Resource ${uri} is empty.` }]
      );

      const contents = result.contents.map(
        ({ _meta: _ignored, ...rest }) => rest
      );

      return {
        content,
        details: {
          server: server.name,
          tool: READ_MCP_RESOURCE_TOOL,
          ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        },
        structuredContent: toJsonValue({ server: server.name, uri, contents }),
      };
    },
  };

  return [listResources, listTemplates, readResource];
};
