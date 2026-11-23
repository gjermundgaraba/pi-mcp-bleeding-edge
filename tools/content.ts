import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { limitMcpContent } from "@earendil-works/pi-mcp";
import type { LimitedMcpContent, McpOutputSaver } from "@earendil-works/pi-mcp";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/client";

import { errorMessage } from "../connection/errors.ts";

/** The tool that reads resources named by resource links. */
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/** Content a model accepts in tool results. */
export type ModelContent = TextContent | ImageContent;

/** How server content becomes model content. */
export interface ContentOptions {
  /** Whether resource links name `read_mcp_resource`, the tool that reads them. */
  readonly readableResources?: boolean | undefined;
  /** Saves what the model is not shown in full, and returns where. Without it, that output is cut or omitted. */
  readonly saveOutput?: McpOutputSaver | undefined;
}

/** A byte count as pi shows it, such as `2.0KB`. */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const extensionOf = (uri: string): string => {
  const url = URL.canParse(uri) ? new URL(uri) : undefined;
  const location = url === undefined ? uri : `${url.host}${url.pathname}`;

  return /\.[A-Za-z0-9]{1,8}$/u.exec(location)?.[0] ?? ".bin";
};

const isTextMimeType = (mimeType: string | undefined): boolean => {
  const type = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
};

const resourceLink = (
  server: string,
  block: Extract<ContentBlock, { type: "resource_link" }>,
  readable: boolean
): string => {
  const details = [
    block.mimeType,
    block.size === undefined ? undefined : formatSize(block.size),
  ].filter((detail) => detail !== undefined && detail !== "");

  const kind = details.length > 0 ? ` (${details.join(", ")})` : "";
  const described = block.description ?? "";
  const description = described === "" ? "" : `: ${described}`;

  const read = readable
    ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")`
    : "";

  return `[Resource ${block.uri} "${block.title ?? block.name}"${kind}${description}${read}]`;
};

const binaryResource = async (
  uri: string,
  mimeType: string | undefined,
  data: Buffer,
  saveOutput: McpOutputSaver | undefined
): Promise<string> => {
  const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;

  if (saveOutput === undefined) {
    return `[Binary resource ${uri} (${kind}) omitted]`;
  }

  try {
    return `[Binary resource ${uri} (${kind}) saved to ${await saveOutput(data, extensionOf(uri))}]`;
  } catch (error) {
    return `[Binary resource ${uri} (${kind}) could not be saved: ${errorMessage(error)}]`;
  }
};

const blockToContent = async (
  server: string,
  block: ContentBlock,
  options: ContentOptions
): Promise<ModelContent> => {
  switch (block.type) {
    case "text": {
      return { type: "text", text: block.text };
    }

    case "image": {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }

    case "audio": {
      return { type: "text", text: `[audio ${block.mimeType} omitted]` };
    }

    case "resource_link": {
      return {
        type: "text",
        text: resourceLink(server, block, options.readableResources === true),
      };
    }

    case "resource": {
      const { resource } = block;

      if ("text" in resource) {
        return { type: "text", text: resource.text };
      }

      if (resource.mimeType?.startsWith("image/") === true) {
        return {
          type: "image",
          data: resource.blob,
          mimeType: resource.mimeType,
        };
      }

      const data = Buffer.from(resource.blob, "base64");

      return {
        type: "text",
        text: isTextMimeType(resource.mimeType)
          ? data.toString("utf8")
          : await binaryResource(
              resource.uri,
              resource.mimeType,
              data,
              options.saveOutput
            ),
      };
    }
  }
};

/**
 * Model-facing content of a server's content blocks, before the output limit: text and images pass
 * through, resource links name the resource (and `read_mcp_resource` when `readableResources`),
 * binary resources are saved with `saveOutput`, or omitted without it.
 */
export const toModelContent = async (
  server: string,
  blocks: readonly ContentBlock[],
  options: ContentOptions = {}
): Promise<ModelContent[]> =>
  await Promise.all(
    blocks.map(async (block) => await blockToContent(server, block, options))
  );

const modelContentOf = async (
  server: string,
  result: CallToolResult,
  options: ContentOptions
): Promise<ModelContent[]> => {
  if (result.content.length > 0) {
    return await toModelContent(server, result.content, options);
  }

  return result.structuredContent === undefined
    ? []
    : [
        {
          type: "text",
          text: JSON.stringify(result.structuredContent, null, 2),
        },
      ];
};

/**
 * Model-facing content of a tool result within pi's MCP output limit: longer text is cut in the
 * middle, and with `saveOutput` the full text is saved where the result names. A result without content shows its
 * structured content, and an error without text says which tool failed.
 */
export const toolResultContent = async (
  server: string,
  tool: string,
  result: CallToolResult,
  options: ContentOptions = {}
): Promise<LimitedMcpContent> => {
  const converted = await modelContentOf(server, result, options);

  const text = converted
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

  if (result.isError === true && text === "") {
    converted.push({
      type: "text",
      text: `MCP tool ${server}/${tool} returned an error`,
    });
  }

  return await limitMcpContent(converted, options.saveOutput);
};
