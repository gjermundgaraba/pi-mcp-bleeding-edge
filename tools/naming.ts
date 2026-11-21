import { createHash } from "node:crypto";

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>` with everything but `[A-Za-z0-9_]` replaced by `_`, the names pi's
 * built-in MCP support and Codex give MCP tools. Names over 64 characters, and names `isTaken`
 * reports as used by another tool, get a hash suffix.
 */
export const mcpToolName = (
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false
): string => {
  const name = `mcp__${server}__${tool}`.replaceAll(/[^A-Za-z0-9_]/gu, "_");

  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) {
    return name;
  }

  const hash = createHash("sha256")
    .update(`${server}\0${tool}`)
    .digest("hex")
    .slice(0, 8);

  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
};

/** `mcp__<server>` with `-` replaced by `_`: server names that differ only there share it. */
export const mcpNamespace = (server: string): string =>
  `mcp__${server.replaceAll("-", "_")}`;

/** The first line of the configured description, else of the server's instructions. */
export const serverSummary = (
  description: string | undefined,
  instructions: string | undefined
): string => {
  const described = description?.trim() ?? "";
  const text = described === "" ? (instructions?.trim() ?? "") : described;

  return (text.split("\n", 1)[0] ?? "").trim();
};
