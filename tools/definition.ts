import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ToolAnnotations,
  ToolDefinition,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";
import { z } from "zod";

import { toPiExposure } from "../config/exposure.ts";
import type { McpExposure } from "../config/exposure.ts";
import type { CallOptions, ToolArguments } from "../connection/connection.ts";
import { limitContent, toJsonValue, toModelContent } from "./content.ts";
import type { ContentOptions, ModelContent } from "./content.ts";
import { mcpToolRenderers } from "./render.ts";

/** What a tool call needs of its server's connection. */
export interface ToolCaller {
  readonly callTool: (
    name: string,
    args: ToolArguments,
    options: CallOptions
  ) => Promise<CallToolResult>;
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

const toolArguments = z.record(z.string(), z.unknown());

const localRef = z
  .string()
  .refine((ref) => ref === "#" || ref.startsWith("#/"));

/** `schema` moved below `pointer` of another schema, with its local `$ref`s rewritten to match. */
const relocateSchema = (schema: JsonValue, pointer: string): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map((item: JsonValue) => relocateSchema(item, pointer));
  }

  if (!(schema instanceof Object)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]): [string, JsonValue] => {
      const ref = localRef.safeParse(value);

      if (key === "$ref" && ref.success) {
        return [key, `${pointer}${ref.data.slice(1)}`];
      }

      if (SCHEMA_DATA_KEYWORDS.has(key)) {
        return [key, value];
      }

      if (
        SCHEMA_MAP_KEYWORDS.has(key) &&
        value instanceof Object &&
        !Array.isArray(value)
      ) {
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
    })
  );
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
            toJsonValue(outputSchema),
            "#/properties/structuredContent"
          ),
    isError: { type: "boolean" },
  },
  required: ["content"],
  additionalProperties: true,
});

/** An input schema as tool APIs accept it: an object schema with `properties`. */
export const normalizeInputSchema = (schema: Tool["inputSchema"]): TSchema => ({
  ...schema,
  type: "object",
  properties: schema.properties ?? {},
});

const textOf = (content: readonly ModelContent[]): string =>
  content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

const modelContentOf = async (
  server: string,
  result: CallToolResult,
  options: ContentOptions
): Promise<ModelContent[]> => {
  if (result.content.length > 0) {
    return await toModelContent(server, result.content, options);
  }

  if (result.structuredContent === undefined) {
    return [];
  }

  return [
    { type: "text", text: JSON.stringify(result.structuredContent, null, 2) },
  ];
};

/**
 * A tool result for pi: model content within the output limit, and the whole result without
 * `_meta` as `structuredContent` for codemode scripts. `isError` results are errors for the model;
 * scripts still receive them.
 */
export const convertResult = async (
  server: string,
  tool: string,
  result: CallToolResult,
  options: ContentOptions = {}
): Promise<AgentToolResult<McpToolDetails>> => {
  const converted = await modelContentOf(server, result, options);
  const isError = result.isError === true;

  if (isError && textOf(converted) === "") {
    converted.push({
      type: "text",
      text: `MCP tool ${server}/${tool} returned an error`,
    });
  }

  const { content, fullOutputPath } = await limitContent(
    converted,
    options.save
  );

  const { _meta: _ignored, ...scriptResult } = result;

  return {
    content,
    details: {
      server,
      tool,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
    structuredContent: toJsonValue(scriptResult),
    ...(isError ? { isError: true } : {}),
  };
};

const annotationsOf = (tool: Tool): ToolAnnotations | undefined => {
  const hints = tool.annotations;

  if (hints === undefined) {
    return undefined;
  }

  const annotations: ToolAnnotations = {
    ...(hints.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: hints.readOnlyHint }),
    ...(hints.destructiveHint === undefined
      ? {}
      : { destructiveHint: hints.destructiveHint }),
    ...(hints.idempotentHint === undefined
      ? {}
      : { idempotentHint: hints.idempotentHint }),
    ...(hints.openWorldHint === undefined
      ? {}
      : { openWorldHint: hints.openWorldHint }),
  };

  return Object.keys(annotations).length > 0 ? annotations : undefined;
};

const describe = (server: string, tool: Tool): string => {
  const candidates = [
    tool.description?.trim(),
    tool.title,
    tool.annotations?.title,
  ];

  return (
    candidates.find((text) => text !== undefined && text !== "") ??
    `MCP tool ${tool.name} from server ${server}`
  );
};

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
    parameters: normalizeInputSchema(tool.inputSchema),
    outputSchema: resultSchema(tool.outputSchema),
    exposure: toPiExposure(options.exposure),
    namespace: options.namespace,
    ...(annotations === undefined ? {} : { annotations }),
    ...mcpToolRenderers(label),
    async execute(_toolCallId, params, signal, onUpdate) {
      const caller = await options.caller();

      const result = await caller.callTool(
        tool.name,
        toolArguments.parse(params ?? {}),
        {
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
        }
      );

      return await convertResult(server, tool.name, result, {
        readableResources: options.readableResources(),
      });
    },
  };
};
