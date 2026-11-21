import type {
  ImageContent,
  JsonValue,
  TextContent,
} from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { z } from "zod";

import { writeOutputFile } from "../output-files.ts";

/** Model-facing text of an MCP result beyond this is cut in the middle, as Codex does. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/** The tool that reads resources named by resource links. */
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

/** Content a model accepts in tool results. */
export type ModelContent = TextContent | ImageContent;

/** Model-facing content within the output limit, and where the full text went when it was cut. */
export interface LimitedContent {
  readonly content: ModelContent[];
  readonly fullOutputPath?: string | undefined;
}

/** Saves output to a file the model can read and returns its path. `extension` includes the dot. */
export type OutputSaver = (
  data: string | Uint8Array,
  extension: string
) => Promise<string>;

const saveToTempFile: OutputSaver = async (data, extension) =>
  await writeOutputFile(extension, data);

const json = z.json();

/**
 * A result as JSON for codemode scripts. Results come off the wire as JSON; one that does not parse
 * as JSON as it is (for example with `undefined` fields) goes through its JSON text.
 */
export const toJsonValue = (value: unknown): JsonValue => {
  const direct = json.safeParse(value);

  if (direct.success) {
    return direct.data;
  }

  const text = JSON.stringify(value) ?? "null";
  const reparsed: unknown = JSON.parse(text);

  return json.parse(reparsed);
};

const truncateMiddle = (
  text: string,
  maxBytes: number
): { content: string; totalBytes: number; totalLines: number } | undefined => {
  const bytes = Buffer.from(text, "utf8");

  if (bytes.length <= maxBytes) {
    return undefined;
  }

  const isBoundary = (index: number) =>
    index >= bytes.length || ((bytes[index] ?? 0) & 0xc0) !== 0x80;

  let headEnd = Math.floor(maxBytes / 2);

  while (headEnd > 0 && !isBoundary(headEnd)) {
    headEnd -= 1;
  }

  let tailStart = bytes.length - (maxBytes - Math.floor(maxBytes / 2));

  while (tailStart < bytes.length && !isBoundary(tailStart)) {
    tailStart += 1;
  }

  const cut = bytes.subarray(headEnd, tailStart).toString("utf8");
  const astral = cut.match(/[\u{10000}-\u{10FFFF}]/gu)?.length ?? 0;
  const removed = cut.length - astral;

  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

  return {
    content: `${bytes.subarray(0, headEnd).toString("utf8")}…${removed} chars truncated…${bytes.subarray(tailStart).toString("utf8")}`,
    totalBytes: bytes.length,
    totalLines: lines,
  };
};

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text keeps its start and end
 * around a `…N chars truncated…` marker, and the full text is saved where the model can read it.
 * Images are kept.
 */
export const limitContent = async (
  content: ModelContent[],
  save: OutputSaver = saveToTempFile
): Promise<LimitedContent> => {
  const combined = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

  const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);

  if (truncation === undefined) {
    return { content };
  }

  let fullOutputPath: string | undefined;
  let where: string;

  try {
    fullOutputPath = await save(combined, ".txt");
    where = `\n\n[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }

  const tokens = Math.ceil(truncation.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}${where}`;

  return {
    content: [
      { type: "text", text },
      ...content.filter((block) => block.type === "image"),
    ],
    fullOutputPath,
  };
};

const extensionOf = (uri: string): string => {
  const url = URL.canParse(uri) ? new URL(uri) : undefined;
  const path = url === undefined ? uri : `${url.host}${url.pathname}`;

  return /\.[A-Za-z0-9]{1,8}$/u.exec(path)?.[0] ?? ".bin";
};

const isTextMimeType = (mimeType: string | undefined): boolean => {
  const type = mimeType?.split(";", 1)[0]?.trim().toLowerCase();

  if (type === undefined || type === "") {
    return false;
  }

  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
};

/** Options of converting a server's content blocks. */
export interface ContentOptions {
  /** Whether `read_mcp_resource` can read the server's resources, which resource links then name. */
  readonly readableResources?: boolean | undefined;
  readonly save?: OutputSaver | undefined;
}

const blockToContent = async (
  server: string,
  block: ContentBlock,
  options: ContentOptions
): Promise<ModelContent[]> => {
  switch (block.type) {
    case "text": {
      return [{ type: "text", text: block.text }];
    }

    case "image": {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }

    case "audio": {
      return [{ type: "text", text: `[audio ${block.mimeType} omitted]` }];
    }

    case "resource_link": {
      const details = [
        block.mimeType,
        block.size === undefined ? undefined : formatSize(block.size),
      ].filter(Boolean);

      const read =
        options.readableResources === true
          ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")`
          : "";

      const describedAs = block.description ?? "";
      const description = describedAs === "" ? "" : `: ${describedAs}`;
      const kind = details.length > 0 ? ` (${details.join(", ")})` : "";

      return [
        {
          type: "text",
          text: `[Resource ${block.uri} "${block.title ?? block.name}"${kind}${description}${read}]`,
        },
      ];
    }

    case "resource": {
      const { resource } = block;

      if ("text" in resource) {
        return [{ type: "text", text: resource.text }];
      }

      if (resource.mimeType?.startsWith("image/") === true) {
        return [
          { type: "image", data: resource.blob, mimeType: resource.mimeType },
        ];
      }

      const data = Buffer.from(resource.blob, "base64");

      if (isTextMimeType(resource.mimeType)) {
        return [{ type: "text", text: data.toString("utf8") }];
      }

      const kind = `${resource.mimeType ?? "unknown type"}, ${formatSize(data.length)}`;

      try {
        const path = await (options.save ?? saveToTempFile)(
          data,
          extensionOf(resource.uri)
        );

        return [
          {
            type: "text",
            text: `[Binary resource ${resource.uri} (${kind}) saved to ${path}]`,
          },
        ];
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return [
          {
            type: "text",
            text: `[Binary resource ${resource.uri} (${kind}) could not be saved: ${reason}]`,
          },
        ];
      }
    }
  }
};

/**
 * Model-facing content of a server's content blocks, before the output limit: text and images pass
 * through, resource links name the resource, binary resources are saved to temporary files.
 */
export const toModelContent = async (
  server: string,
  blocks: readonly ContentBlock[],
  options: ContentOptions = {}
): Promise<ModelContent[]> => {
  const converted = await Promise.all(
    blocks.map(async (block) => await blockToContent(server, block, options))
  );

  return converted.flat();
};
