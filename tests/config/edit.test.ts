import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { updateServerConfig } from "../../config/edit.ts";
import { temporaryDirectory } from "../fixtures/connection.ts";

const cleanups: Array<() => void> = [];

const cleanUp = (): void => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
};

const file = (content: string): string => {
  const { dir, dispose } = temporaryDirectory();

  cleanups.push(dispose);

  const target = path.join(dir, "mcp.json");

  writeFileSync(target, content);

  return target;
};

describe("updateServerConfig", () => {
  afterEach(cleanUp);

  it("removes default values from a definition and keeps the file's indentation and other content", async () => {
    const target = file(
      `{\n    "other": 1,\n    "mcpServers": {\n        "docs": { "url": "https://x/mcp", "enabled": false, "exposure": "direct" }\n    }\n}\n`
    );

    await updateServerConfig(target, "docs", {
      enabled: true,
      exposure: "codemode",
    });

    expect(readFileSync(target, "utf8")).toBe(
      `{\n    "other": 1,\n    "mcpServers": {\n        "docs": {\n            "url": "https://x/mcp"\n        }\n    }\n}\n`
    );
  });

  it("adds a project override that keeps default values, since they replace the global server's", async () => {
    const target = file("");

    await updateServerConfig(
      target,
      "docs",
      { enabled: true },
      { override: true }
    );

    expect(JSON.parse(readFileSync(target, "utf8"))).toStrictEqual({
      mcpServers: { docs: { enabled: true } },
    });
  });

  it("refuses to edit a server the file does not define", async () => {
    const target = file('{ "mcpServers": {} }');

    await expect(
      updateServerConfig(target, "docs", { enabled: false })
    ).rejects.toThrow('does not define MCP server "docs"');
  });
});
