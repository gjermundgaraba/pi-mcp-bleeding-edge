import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerCredentials } from "../../oauth/store.ts";
import { temporaryDirectory } from "../fixtures/connection.ts";

const tokens = (access: string) => ({
  tokens: { access_token: access, token_type: "Bearer" },
});

describe("ServerCredentials", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  const directory = (): string => {
    const { dir, dispose } = temporaryDirectory();

    cleanups.push(dispose);

    return dir;
  };

  it("keeps each server, and each name for the same URL, in its own file", async () => {
    const dir = directory();
    const work = new ServerCredentials(dir, "work", "https://x.example/mcp");

    const personal = new ServerCredentials(
      dir,
      "personal",
      "https://x.example/mcp"
    );

    await work.update(() => tokens("a"));
    await personal.update(() => tokens("b"));

    expect(
      readdirSync(dir).filter((file) => file.endsWith(".json"))
    ).toHaveLength(2);
    expect(work.read()?.tokens?.access_token).toBe("a");
    expect(personal.read()?.tokens?.access_token).toBe("b");
  });

  it("reads a corrupt file as signed out without touching other servers, and replaces it on the next write", async () => {
    const dir = directory();

    const broken = new ServerCredentials(
      dir,
      "broken",
      "https://x.example/mcp"
    );

    const intact = new ServerCredentials(
      dir,
      "intact",
      "https://y.example/mcp"
    );

    await broken.update(() => tokens("a"));

    const file = readdirSync(dir).find((name) => name.endsWith(".json")) ?? "";

    await intact.update(() => tokens("b"));
    writeFileSync(path.join(dir, file), "{ not json");

    expect(broken.read()).toBeUndefined();
    expect(intact.read()?.tokens?.access_token).toBe("b");

    await broken.update(() => tokens("c"));

    expect(broken.read()?.tokens?.access_token).toBe("c");
  });

  it("removes a server's state and reports whether there was any", async () => {
    const credentials = new ServerCredentials(
      directory(),
      "a",
      "https://x.example/mcp"
    );

    await credentials.update(() => tokens("a"));

    await expect(credentials.remove()).resolves.toBe(true);
    expect(credentials.read()).toBeUndefined();
    await expect(credentials.remove()).resolves.toBe(false);
  });
});
