import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ToolAnnotations,
  ToolDefinition,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { normalizeMcpInputSchema } from "@earendil-works/pi-mcp";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";

import { toPiExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import type { CallOptions, ToolArguments } from "../connection/connection.ts";
import { writeOutputFile } from "../output-files.ts";
import { toolResultContent } from "./content.ts";
import { asJsonValue } from "./json.ts";
import { mcpToolRenderers } from "./render.ts";

/** What a tool call needs of its server's connection. */
export interface ToolCaller {
  callTool(
    name: string,
    args: ToolArguments,
    options: CallOptions
  ): Promise<CallToolResult>;
}

/** Details of MCP tool results, for rendering. */
export interface McpToolDetails {
  readonly server: string;
  readonly tool: string;
  /** The temporary file with the full text, when the model-facing text was cut. */
  readonly fullOutputPath?: string | undefined;
}

const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "const",
  "enum",
  "default",
  "examples",
]);

const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `schema` moved below `pointer` of another schema, with its local `$ref`s rewritten to match. */
const relocateSchema = (schema: JsonValue, pointer: string): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map((item: JsonValue) => relocateSchema(item, pointer));
  }

  if (!isObject(schema)) {
    return schema;
  }

  const entries = Object.entries(schema).map(
    ([key, value]): [string, JsonValue] => {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        (value === "#" || value.startsWith("#/"))
      ) {
        return [key, `${pointer}${value.slice(1)}`];
      }

      if (SCHEMA_DATA_KEYWORDS.has(key)) {
        return [key, value];
      }

      if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, sub]) => [
              name,
              relocateSchema(sub, pointer),
            ])
          ),
        ];
      }

      return [key, relocateSchema(value, pointer)];
    }
  );

  return Object.fromEntries(entries);
};

/**
 * Output schema of every MCP tool: the `CallToolResult` codemode scripts receive, with the tool's
 * own output schema as `structuredContent`.
 */
export const resultSchema = (outputSchema: Tool["outputSchema"]): TSchema => ({
  type: "object",
  properties: {
    content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
    structuredContent:
      outputSchema === undefined
        ? {}
        : relocateSchema(
            asJsonValue(outputSchema),
            "#/properties/structuredContent"
          ),
    isError: { type: "boolean" },
  },
  required: ["content"],
  additionalProperties: true,
});

/**
 * A tool result for pi: model content within the output limit, and the whole result without
 * `_meta` as `structuredContent` for codemode scripts. `isError` results are errors for the model;
 * scripts still receive them.
 */
export const convertResult = async (
  server: string,
  tool: string,
  result: CallToolResult,
  readableResources = false
): Promise<AgentToolResult<McpToolDetails>> => {
  const { content, fullOutputPath } = await toolResultContent(
    server,
    tool,
    result,
    { readableResources, saveOutput: writeOutputFile }
  );

  const isError = result.isError === true;
  const { _meta: _ignored, ...scriptResult } = result;

  return {
    content,
    details: {
      server,
      tool,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
    structuredContent: asJsonValue(scriptResult),
    ...(isError ? { isError: true } : {}),
  };
};

const annotationsOf = (tool: Tool): ToolAnnotations | undefined => {
  const hints = tool.annotations;

  if (hints === undefined) {
    return undefined;
  }

  const annotations: ToolAnnotations = {};

  for (const hint of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    const value = hints[hint];

    if (value !== undefined) {
      annotations[hint] = value;
    }
  }

  return Object.keys(annotations).length > 0 ? annotations : undefined;
};

const describe = (server: string, tool: Tool): string =>
  [tool.description?.trim(), tool.title, tool.annotations?.title].find(
    (text) => text !== undefined && text !== ""
  ) ?? `MCP tool ${tool.name} from server ${server}`;

/** One server tool as a pi tool. */
export interface ToolDefinitionOptions {
  readonly server: string;
  readonly tool: Tool;
  readonly name: string;
  readonly exposure: McpExposure;
  readonly namespace: ToolNamespace;
  /** The server's current connection, resolved when the call runs, which may be after a reconnect. */
  readonly caller: () => Promise<ToolCaller>;
  readonly readableResources: () => boolean;
}

export const createToolDefinition = (
  options: ToolDefinitionOptions
): ToolDefinition<TSchema, McpToolDetails> => {
  const { server, tool } = options;
  const label = `${server}/${tool.name}`;
  const annotations = annotationsOf(tool);

  return {
    name: options.name,
    label,
    description: describe(server, tool),
    parameters: normalizeMcpInputSchema(tool.inputSchema),
    outputSchema: resultSchema(tool.outputSchema),
    exposure: toPiExposure(options.exposure),
    namespace: options.namespace,
    ...(annotations === undefined ? {} : { annotations }),
    ...mcpToolRenderers(label),
    async execute(
      _toolCallId,
      params: ToolArguments | undefined,
      signal,
      onUpdate
    ) {
      const caller = await options.caller();

      const result = await caller.callTool(tool.name, params ?? {}, {
        signal,
        onProgress: (progress) => {
          const total =
            progress.total === undefined ? "" : `/${progress.total}`;

          const text =
            progress.message ?? `Progress ${progress.progress}${total}`;

          onUpdate?.({
            content: [{ type: "text", text }],
            details: { server, tool: tool.name },
          });
        },
      });

      return await convertResult(
        server,
        tool.name,
        result,
        options.readableResources()
      );
    },
  };
};
