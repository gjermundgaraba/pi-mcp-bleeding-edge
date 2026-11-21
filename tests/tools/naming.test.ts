import { describe, expect, it } from "vite-plus/test";

import {
  mcpNamespace,
  mcpToolName,
  serverSummary,
} from "../../tools/naming.ts";

describe("mcpToolName", () => {
  it("names tools like pi's built-in MCP support", () => {
    expect(mcpToolName("dev-radius", "get.issue")).toBe(
      "mcp__dev_radius__get_issue"
    );
    expect(mcpNamespace("dev-radius")).toBe("mcp__dev_radius");
  });

  it("adds a hash suffix to long and taken names", () => {
    const long = mcpToolName("server", "x".repeat(80));

    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/u);
    expect(mcpToolName("s", "a-b", () => true)).toMatch(
      /^mcp__s__a_b_[0-9a-f]{8}$/u
    );
  });
});

describe("serverSummary", () => {
  it("uses the first line of the description, else of the instructions", () => {
    expect(serverSummary(" Search docs\nmore ", "ignored")).toBe("Search docs");
    expect(serverSummary("  ", "Server help\nmore")).toBe("Server help");
    expect(serverSummary(undefined, undefined)).toBe("");
  });
});
