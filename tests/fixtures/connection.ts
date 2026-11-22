import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ServerEntry } from "../../config/load.ts";
import { parseServerConfig } from "../../config/schema.ts";
import { ServerConnection } from "../../connection/connection.ts";
import { ProtocolVerdicts } from "../../connection/era.ts";
import { ServerLog } from "../../log.ts";

/** The path of a fixture file. */
export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(name, import.meta.url));

/** A stdio config running a fixture server with this node. */
export const stdioFixture = (name: string) => ({
  command: process.execPath,
  args: [fixturePath(name)],
});

/** A directory for one test's files. */
export interface TemporaryDirectory {
  readonly dir: string;
  /** Remove the directory and everything in it. */
  readonly dispose: () => void;
}

export const temporaryDirectory = (): TemporaryDirectory => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-mcp-test-"));

  return {
    dir,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** A validated server entry named `fixture`. */
export const fixtureEntry = (raw: unknown): ServerEntry => {
  const parsed = parseServerConfig("fixture", raw);

  if (parsed.error !== undefined) {
    throw new Error(parsed.error);
  }

  return {
    name: "fixture",
    config: parsed.value,
    source: "test",
    scope: "global",
  };
};

/** A connection to a fixture server, with what it reported. */
export interface ConnectionUnderTest {
  readonly connection: ServerConnection;
  readonly verdicts: ProtocolVerdicts;
  readonly logFile: string;
  readonly toolListings: string[][];
}

export const connectFixture = (
  dir: string,
  raw: unknown,
  verdicts: ProtocolVerdicts = new ProtocolVerdicts(
    path.join(dir, "protocol.json")
  )
): ConnectionUnderTest => {
  const logFile = path.join(dir, "mcp.log");
  const toolListings: string[][] = [];

  const connection = new ServerConnection({
    entry: fixtureEntry(raw),
    cwd: dir,
    verdictKey: "fixture",
    auth: undefined,
    verdicts,
    log: new ServerLog(logFile),
    onTools: (current) => {
      toolListings.push(current.tools.map((tool) => tool.name));
    },
    onChange: () => undefined,
  });

  return { connection, verdicts, logFile, toolListings };
};

/** Poll `check` until it holds, failing after `timeoutMs`. */
export const eventually = async (
  check: () => boolean,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition did not hold in time");
    }

    await sleep(25);
  }
};
