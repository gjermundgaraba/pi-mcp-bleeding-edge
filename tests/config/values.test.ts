import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveConfigValue } from "../../config/values.ts";

const saved = { ...process.env };

const cleanUp = (): void => {
  process.env = { ...saved };
};

describe("resolveConfigValue", () => {
  afterEach(cleanUp);

  it("reads environment variables, keeps escapes, and leaves other text alone", () => {
    process.env["MCP_TEST_TOKEN"] = "secret";

    expect(resolveConfigValue("Bearer ${MCP_TEST_TOKEN}", "header")).toBe(
      "Bearer secret"
    );
    expect(resolveConfigValue("$MCP_TEST_TOKEN!", "header")).toBe("secret!");
    expect(resolveConfigValue("cost: $$5 $!", "header")).toBe("cost: $5 !");
    expect(resolveConfigValue("${not a name}", "header")).toBe("${not a name}");
  });

  it("names every unset variable", () => {
    expect(() =>
      resolveConfigValue("$MCP_TEST_A:${MCP_TEST_B}", 'header "x"')
    ).toThrow(
      'Failed to resolve header "x" from environment variables: MCP_TEST_A, MCP_TEST_B'
    );
  });

  it("uses a command's output", () => {
    expect(resolveConfigValue("!echo from-command", "secret")).toBe(
      "from-command"
    );
    expect(() => resolveConfigValue("!false", "secret")).toThrow(
      "from shell command: false"
    );
  });
});
