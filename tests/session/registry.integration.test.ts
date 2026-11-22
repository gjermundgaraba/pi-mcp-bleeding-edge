import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mcpPaths } from "../../paths.ts";
import { SessionAuth } from "../../session/auth.ts";
import { ServerRegistry } from "../../session/registry.ts";
import type { ServerSlot } from "../../session/registry.ts";
import { startSession } from "../fixtures/agent-session.ts";
import type { SessionUnderTest } from "../fixtures/agent-session.ts";
import {
  eventually,
  stdioFixture,
  temporaryDirectory,
} from "../fixtures/connection.ts";

interface RegistryUnderTest {
  readonly subject: SessionUnderTest;
  readonly registry: ServerRegistry;
  readonly slot: ServerSlot;
}

const savedConfig = (subject: SessionUnderTest): unknown =>
  JSON.parse(readFileSync(path.join(subject.agentDir, "mcp.json"), "utf8"));

const toolNamed = (subject: SessionUnderTest, name: string) =>
  subject.session.getAllTools().find((tool) => tool.name === name);

describe("ServerRegistry in a pi session", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  /** A session whose extension API a registry of its own uses, so it is reached directly. */
  const start = async (): Promise<RegistryUnderTest> => {
    const { dir, dispose } = temporaryDirectory();
    let api: ExtensionAPI | undefined;

    cleanups.push(dispose);

    const subject = await startSession(
      dir,
      { fixture: stdioFixture("stdio-modern.ts") },
      () => [
        (pi) => {
          api = pi;
        },
      ]
    );

    cleanups.push(subject.dispose);

    if (api === undefined) {
      throw new Error("the probe extension did not load");
    }

    const registry = new ServerRegistry({
      pi: api,
      paths: mcpPaths(subject.agentDir),
      auth: new SessionAuth(path.join(dir, "auth")),
      onConnectionChange: () => undefined,
    });

    cleanups.push(async () => {
      await registry.close();
    });
    registry.load(subject.cwd, false);

    const slot = registry.find("fixture");

    await slot?.connection?.settled();

    if (slot === undefined) {
      throw new Error("the fixture server is not configured");
    }

    return { subject, registry, slot };
  };

  it("gives tools whose names collide a hash suffix each, and hides tools the server withdraws", async () => {
    const { subject, slot } = await start();

    const dashed = subject.session
      .getAllTools()
      .filter((tool) => tool.name.startsWith("mcp__fixture__dash_name"));

    expect(dashed.map((tool) => tool.name)).toHaveLength(2);
    expect(
      dashed.every((tool) =>
        /^mcp__fixture__dash_name_[0-9a-f]{8}$/u.test(tool.name)
      )
    ).toBe(true);
    expect(toolNamed(subject, "mcp__fixture__echo")?.exposure).toBe("deferred");

    await slot.connection?.callTool("remove-tool", { name: "echo" }, {});
    await eventually(
      () => toolNamed(subject, "mcp__fixture__echo")?.exposure === "hidden"
    );

    expect(slot.connection?.tools.map((tool) => tool.name)).not.toContain(
      "echo"
    );
  });

  it("saves disabling, enabling, and exposure to mcp.json and applies them to the tools", async () => {
    const { subject, registry, slot } = await start();

    await expect(registry.setEnabled(slot, false)).resolves.toBeUndefined();
    expect(savedConfig(subject)).toMatchObject({
      mcpServers: { fixture: { enabled: false } },
    });
    expect(slot.connection).toBeUndefined();
    expect(toolNamed(subject, "mcp__fixture__echo")?.exposure).toBe("hidden");

    await expect(registry.setEnabled(slot, true)).resolves.toBeUndefined();
    expect(savedConfig(subject)).toStrictEqual({
      mcpServers: { fixture: stdioFixture("stdio-modern.ts") },
    });
    expect(slot.connection?.state).toBe("connected");

    await expect(registry.setExposure(slot, "direct")).resolves.toBeUndefined();
    expect(savedConfig(subject)).toMatchObject({
      mcpServers: { fixture: { exposure: "direct" } },
    });
    expect(toolNamed(subject, "mcp__fixture__echo")?.exposure).toBe("direct");
    expect(subject.session.getActiveToolNames()).toContain(
      "mcp__fixture__echo"
    );
  });
});
