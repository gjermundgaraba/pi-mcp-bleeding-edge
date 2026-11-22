import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { limitMcpContent } from "@earendil-works/pi-mcp";
import type { LimitedMcpContent } from "@earendil-works/pi-mcp";
import type { ContentBlock } from "@modelcontextprotocol/client";

import { errorMessage } from "../connection/errors.ts";
import { writeOutputFile } from "../output-files.ts";

/** The tool that reads resources named by resource links. */
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/** Content a model accepts in tool results. */
export type ModelContent = TextContent | ImageContent;

/**
 * Keep model-facing text within pi's MCP output limit, as pi does: longer text is cut in the middle,
 * and the full text is saved to a temporary file the result names.
 */
export const limitContent = async (
  content: ModelContent[]
): Promise<LimitedMcpContent> =>
  await limitMcpContent(content, writeOutputFile);

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
  data: Buffer
): Promise<string> => {
  const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;

  try {
    return `[Binary resource ${uri} (${kind}) saved to ${await writeOutputFile(data, extensionOf(uri))}]`;
  } catch (error) {
    return `[Binary resource ${uri} (${kind}) could not be saved: ${errorMessage(error)}]`;
  }
};

const blockToContent = async (
  server: string,
  block: ContentBlock,
  readable: boolean
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
      return { type: "text", text: resourceLink(server, block, readable) };
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
          : await binaryResource(resource.uri, resource.mimeType, data),
      };
    }
  }
};

/**
 * Model-facing content of a server's content blocks, before the output limit: text and images pass
 * through, resource links name the resource (and `read_mcp_resource` when `readableResources`),
 * binary resources are saved to temporary files.
 */
export const toModelContent = async (
  server: string,
  blocks: readonly ContentBlock[],
  readableResources = false
): Promise<ModelContent[]> =>
  await Promise.all(
    blocks.map(
      async (block) => await blockToContent(server, block, readableResources)
    )
  );
