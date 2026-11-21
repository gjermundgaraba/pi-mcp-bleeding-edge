import type { JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_SECTION_CHARS,
  renderServersSection,
} from "../../session/prompt-section.ts";
import { fixtureEntry } from "../fixtures/connection.ts";

const server = (name: string, raw: JsonObject, instructions?: string) => ({
  entry: { ...fixtureEntry({ command: "x", ...raw }), name },
  connection: { instructions },
});

describe("renderServersSection", () => {
  it("lists enabled servers with indirect tools, how they are reached, and their summary", () => {
    const section = renderServersSection([
      server("zeta", { exposure: "deferred", description: "Zeta tools" }),
      server("alpha", {}, "Alpha help\nmore"),
      server("off", { enabled: false }),
      server("declared", { exposure: "direct" }),
    ]);

    expect(section).toBe(
      [
        "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts. Load the tools of `tool_search` servers with `tool_search`.",
        "- mcp__alpha (codemode): Alpha help",
        "- mcp__zeta (tool_search): Zeta tools",
      ].join("\n")
    );
  });

  it("is undefined without such servers", () => {
    expect(
      renderServersSection([server("declared", { exposure: "direct" })])
    ).toBeUndefined();
  });

  it("shrinks summaries and counts the servers that do not fit", () => {
    const servers = Array.from({ length: 200 }, (_, index) =>
      server(`server-${String(index).padStart(3, "0")}`, {
        description: "d".repeat(300),
      })
    );

    const section = renderServersSection(servers) ?? "";

    expect(section.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(section).toMatch(
      /- … \d+ more servers; find their tools with searchTools\(\)$/u
    );
  });
});
