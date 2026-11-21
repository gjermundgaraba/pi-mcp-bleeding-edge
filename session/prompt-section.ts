import { configuredExposures } from "../config/exposure.ts";
import type { ServerEntry } from "../config/load.ts";
import { mcpNamespace, serverSummary } from "../tools/naming.ts";

/** Name of the system prompt section listing the servers whose tools are not declared. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/** Characters of one server's summary in the section, as Codex allows for deferred namespaces. */
const MAX_SUMMARY_CHARS = 250;

/** Characters of the whole section: summaries shrink to fit, then the last servers are counted instead. */
export const MAX_SECTION_CHARS = 4096;

/** What the section needs of a server. */
export interface ListedServer {
  readonly entry: ServerEntry;
  readonly connection?:
    | { readonly instructions: string | undefined }
    | undefined;
}

const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  if (max <= 1) {
    return "";
  }

  const cutsPair = (text.codePointAt(max - 2) ?? 0) > 0xff_ff;
  const end = cutsPair ? max - 2 : max - 1;

  return `${text.slice(0, end).trimEnd()}…`;
};

const omitted = (count: number): string[] =>
  count > 0
    ? [
        `- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`,
      ]
    : [];

const intro = (reaches: ReadonlySet<string>): string => {
  let text = "MCP servers whose tools are not declared to you.";

  if (reaches.has("codemode")) {
    text += " Call the tools of `codemode` servers from codemode scripts.";
  }

  if (reaches.has("tool_search")) {
    text += " Load the tools of `tool_search` servers with `tool_search`.";
  }

  return text;
};

/**
 * The `mcp_servers` section: every enabled server with codemode or deferred tools, how its tools
 * are reached, and a one-line summary. Neither codemode nor tool_search lists the servers, so the
 * model learns of them here. `undefined` when there are none.
 */
export const renderServersSection = (
  servers: readonly ListedServer[]
): string | undefined => {
  const listed = servers
    .filter((server) => {
      if (server.entry.config.enabled === false) {
        return false;
      }

      const exposures = configuredExposures(server.entry.config);

      return exposures.has("codemode") || exposures.has("deferred");
    })
    .toSorted((a, b) => a.entry.name.localeCompare(b.entry.name));

  if (listed.length === 0) {
    return undefined;
  }

  const reaches = listed.map((server) =>
    configuredExposures(server.entry.config).has("codemode")
      ? "codemode"
      : "tool_search"
  );

  const head = intro(new Set(reaches));

  const lines = listed.map(
    (server, index) =>
      `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`
  );

  const size = (kept: number) =>
    [head, ...lines.slice(0, kept), ...omitted(listed.length - kept)].join("\n")
      .length;

  let kept = listed.length;

  while (kept > 0 && size(kept) > MAX_SECTION_CHARS) {
    kept -= 1;
  }

  const perServer =
    kept === 0
      ? 0
      : Math.min(
          MAX_SUMMARY_CHARS,
          Math.floor((MAX_SECTION_CHARS - size(kept)) / kept) - 2
        );

  const described = listed.slice(0, kept).map((server, index) => {
    const summary =
      perServer > 0
        ? truncate(
            serverSummary(
              server.entry.config.description,
              server.connection?.instructions
            ),
            perServer
          )
        : "";

    const line = lines[index] ?? "";

    return summary === "" ? line : `${line}: ${summary}`;
  });

  return [head, ...described, ...omitted(listed.length - kept)].join("\n");
};
