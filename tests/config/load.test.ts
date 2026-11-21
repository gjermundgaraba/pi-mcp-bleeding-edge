import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadConfig } from "../../config/load.ts";
import { mcpPaths } from "../../paths.ts";
import { temporaryDirectory } from "../fixtures/connection.ts";

const cleanups: Array<() => void> = [];

const cleanUp = (): void => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
};

const setUp = (global: unknown, project?: unknown) => {
  const { dir, dispose } = temporaryDirectory();

  cleanups.push(dispose);

  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "project");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(global));

  if (project !== undefined) {
    writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
  }

  return { paths: mcpPaths(agentDir), cwd };
};

describe("loadConfig", () => {
  afterEach(cleanUp);

  it("lets a trusted project override enabled and exposure of a global server, keeping the rest", () => {
    const { paths, cwd } = setUp(
      {
        mcpServers: {
          docs: {
            url: "https://x/mcp",
            headers: { Authorization: "Bearer t" },
          },
        },
      },
      { mcpServers: { docs: { enabled: false, exposure: "direct" } } }
    );

    const loaded = loadConfig(paths, cwd, true);

    expect(loaded.errors).toStrictEqual([]);
    expect(loaded.servers).toStrictEqual([
      {
        name: "docs",
        source: paths.globalConfig,
        scope: "global",
        override: paths.projectConfig(cwd),
        config: {
          url: "https://x/mcp",
          headers: { Authorization: "Bearer t" },
          enabled: false,
          exposure: "direct",
        },
      },
    ]);
  });

  it("ignores the project file of an untrusted project", () => {
    const { paths, cwd } = setUp(
      { mcpServers: {} },
      { mcpServers: { tools: { command: "x" } } }
    );

    expect(loadConfig(paths, cwd, false).servers).toStrictEqual([]);
  });

  it("reports invalid entries, clashing names, project auth, and bad overrides without dropping valid servers", () => {
    const { paths, cwd } = setUp(
      {
        autoEnableCodemode: false,
        mcpServers: {
          "a-b": { command: "x" },
          a_b: { command: "y" },
          broken: { command: 1 },
        },
      },
      {
        mcpServers: {
          web: { url: "https://x/mcp", auth: { provider: "radius" } },
          missing: { enabled: false },
          "a-b": { enabled: false, command2: "x" },
        },
      }
    );

    const loaded = loadConfig(paths, cwd, true);

    expect(loaded.servers.map((server) => server.name)).toStrictEqual(["a-b"]);
    expect(loaded.autoEnableCodemode).toBe(false);
    expect(loaded.errors).toHaveLength(5);
    expect(loaded.errors.join("\n")).toContain(
      'server "a_b" conflicts with "a-b"'
    );
    expect(loaded.errors.join("\n")).toContain(
      "auth is only allowed in the global mcp.json"
    );
    expect(loaded.errors.join("\n")).toContain(
      'server "missing" needs "command" or "url"'
    );
  });
});
