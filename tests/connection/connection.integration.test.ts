import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { SkillVerificationError } from "@modelcontextprotocol/client/ext/skills";
import type { Skill } from "@modelcontextprotocol/client/ext/skills";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MODERN_PROTOCOL_VERSION } from "../../connection/era.ts";
import {
  connectFixture,
  eventually,
  stdioFixture,
  temporaryDirectory,
} from "../fixtures/connection.ts";
import type { ConnectionUnderTest } from "../fixtures/connection.ts";
import {
  startLegacyHttpServer,
  startModernHttpServer,
} from "../fixtures/http-servers.ts";
import type { RunningServer } from "../fixtures/http-servers.ts";

const cleanups: Array<() => Promise<void> | void> = [];

const track = <T extends ConnectionUnderTest>(subject: T): T => {
  cleanups.push(async () => {
    await subject.connection.close();
  });

  return subject;
};

const directory = (): string => {
  const { dir, dispose } = temporaryDirectory();

  cleanups.push(dispose);

  return dir;
};

const server = async (start: () => Promise<RunningServer>): Promise<string> => {
  const running = await start();

  cleanups.push(running.close);

  return running.url;
};

const textOf = (result: {
  content: Array<{ type: string; text?: string }>;
}): string => result.content.map((block) => block.text ?? "").join("");

const cleanUp = async (): Promise<void> => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
};

describe("ServerConnection over stdio", () => {
  afterEach(cleanUp);

  it("negotiates 2026-07-28 with a v2 server and remembers the verdict", async () => {
    const dir = directory();

    const { connection, verdicts } = track(
      connectFixture(dir, stdioFixture("stdio-modern.ts"))
    );

    await connection.getClient();

    expect(connection.era).toBe("modern");
    expect(connection.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(connection.instructions).toBe(
      "Fixture tools for tests.\nSecond line."
    );
    expect(connection.tools.map((tool) => tool.name)).toContain("echo");
    expect(verdicts.prior("fixture")?.kind).toBe("modern");

    const result = await connection.callTool("echo", { text: "hi" }, {});

    expect(textOf(result)).toBe("hi");
  });

  it("falls back to the 2025 handshake with a 2025-only server", async () => {
    const dir = directory();

    const { connection, verdicts } = track(
      connectFixture(dir, stdioFixture("stdio-legacy.ts"))
    );

    await connection.getClient();

    expect(connection.era).toBe("legacy");
    expect(verdicts.prior("fixture")).toStrictEqual({ kind: "legacy" });
    expect(textOf(await connection.callTool("echo", { text: "old" }, {}))).toBe(
      "old"
    );
  });

  it("probes again when a remembered modern verdict no longer holds", async () => {
    const dir = directory();
    const modern = track(connectFixture(dir, stdioFixture("stdio-modern.ts")));

    await modern.connection.getClient();
    await modern.connection.close();

    const legacy = track(
      connectFixture(dir, stdioFixture("stdio-legacy.ts"), modern.verdicts)
    );

    await legacy.connection.getClient();

    expect(legacy.connection.era).toBe("legacy");
    expect(legacy.verdicts.prior("fixture")).toStrictEqual({ kind: "legacy" });
  });

  it("speaks the 2025 protocol to a v2 server when the config asks for legacy", async () => {
    const dir = directory();

    const { connection, verdicts } = track(
      connectFixture(dir, {
        ...stdioFixture("stdio-modern.ts"),
        protocol: "legacy",
      })
    );

    await connection.getClient();

    expect(connection.era).toBe("legacy");
    expect(verdicts.prior("fixture")).toBeUndefined();
  });

  it("fails a server pinned to 2026-07-28 that speaks only 2025", async () => {
    const dir = directory();

    const { connection } = track(
      connectFixture(dir, {
        ...stdioFixture("stdio-legacy.ts"),
        protocol: "modern",
      })
    );

    await expect(connection.getClient()).rejects.toThrow(/failed to connect/u);
    expect(connection.state).toBe("failed");
  });

  it("lists the tools again when a 2026-07-28 server announces a change", async () => {
    const dir = directory();
    const subject = track(connectFixture(dir, stdioFixture("stdio-modern.ts")));

    await subject.connection.getClient();
    await subject.connection.callTool("add-tool", { name: "later" }, {});
    await eventually(() =>
      subject.connection.tools.some((tool) => tool.name === "later")
    );

    expect(subject.toolListings.at(-1)).toContain("later");
  });

  it("lists the tools again when a 2025-era server announces a change", async () => {
    const dir = directory();
    const subject = track(connectFixture(dir, stdioFixture("stdio-legacy.ts")));

    await subject.connection.getClient();
    await subject.connection.callTool("add-tool", { name: "later" }, {});
    await eventually(() =>
      subject.connection.tools.some((tool) => tool.name === "later")
    );

    expect(subject.toolListings.at(-1)).toContain("later");
  });

  it("reports progress, error results, and resources", async () => {
    const dir = directory();

    const { connection } = track(
      connectFixture(dir, stdioFixture("stdio-modern.ts"))
    );

    const progress: number[] = [];

    const counted = await connection.callTool(
      "count",
      { to: 3 },
      {
        onProgress: (update) => {
          progress.push(update.progress);
        },
      }
    );

    const failed = await connection.callTool("fail", {}, {});
    const { resources } = await connection.listResources(undefined, {});
    const read = await connection.readResource("notes://first", {});

    expect(textOf(counted)).toBe("counted to 3");
    expect(progress).toStrictEqual([1, 2, 3]);
    expect(failed.isError).toBe(true);
    expect(connection.hasResources).toBe(true);
    expect(resources.map((resource) => resource.uri)).toStrictEqual([
      "notes://first",
    ]);
    expect(read.contents[0]).toMatchObject({ text: "hello from a resource" });
  });

  it("appends what a stdio server writes to stderr to the server log", async () => {
    const dir = directory();

    const { connection, logFile } = track(
      connectFixture(dir, stdioFixture("stdio-modern.ts"))
    );

    await connection.getClient();
    await eventually(() => {
      try {
        return readFileSync(logFile, "utf8").includes(
          "[fixture] stderr fixture server started"
        );
      } catch {
        return false;
      }
    });

    expect(readFileSync(logFile, "utf8")).toContain(
      "stderr fixture server started"
    );
  });

  it("is closed after close()", async () => {
    const dir = directory();
    const { connection } = connectFixture(dir, stdioFixture("stdio-modern.ts"));

    await connection.getClient();
    await connection.close();

    expect(connection.state).toBe("closed");
    await expect(connection.getClient()).rejects.toThrow(/shut down/u);
  });
});

describe("ServerConnection over Streamable HTTP", () => {
  afterEach(cleanUp);

  it("negotiates 2026-07-28 with a v2 handler", async () => {
    const dir = directory();
    const url = await server(startModernHttpServer);
    const { connection } = track(connectFixture(dir, { url }));

    await connection.getClient();

    expect(connection.era).toBe("modern");
    expect(textOf(await connection.callTool("echo", { text: "web" }, {}))).toBe(
      "web"
    );
  });

  it("speaks 2025 to the same handler when the config asks for legacy", async () => {
    const dir = directory();
    const url = await server(startModernHttpServer);

    const { connection } = track(
      connectFixture(dir, { url, protocol: "legacy" })
    );

    await connection.getClient();

    expect(connection.era).toBe("legacy");
    expect(textOf(await connection.callTool("echo", { text: "web" }, {}))).toBe(
      "web"
    );
  });

  it("lists the tools again when a v2 handler publishes a change", async () => {
    const dir = directory();
    const url = await server(startModernHttpServer);
    const subject = track(connectFixture(dir, { url }));

    await subject.connection.getClient();
    await subject.connection.callTool("add-tool", { name: "later" }, {});
    await eventually(() =>
      subject.connection.tools.some((tool) => tool.name === "later")
    );

    expect(subject.connection.era).toBe("modern");
  });

  it("falls back to a sessionful 2025-only server", async () => {
    const dir = directory();
    const url = await server(startLegacyHttpServer);
    const { connection, verdicts } = track(connectFixture(dir, { url }));

    await connection.getClient();

    expect(connection.era).toBe("legacy");
    expect(verdicts.prior("fixture")).toStrictEqual({ kind: "legacy" });
    expect(
      textOf(await connection.callTool("echo", { text: "kept" }, {}))
    ).toBe("kept");
  });
});

const greetUri = "skill://greet/SKILL.md";

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** The digest the entry lists for the bundled file `refs/tone.md`. */
const toneDigest = (skill: Skill | undefined): string | undefined => {
  const files = skill?.resources;

  return files === "dynamic"
    ? undefined
    : files?.find((file) => file.uri === "skill://greet/refs/tone.md")?.digest;
};

describe("ServerConnection skills", () => {
  afterEach(cleanUp);

  it.each([
    { era: "modern", protocol: "auto" },
    { era: "legacy", protocol: "legacy" },
  ] as const)(
    "lists, reads verified, and refreshes a changed skill on the $era era",
    async ({ era, protocol }) => {
      const dir = directory();
      const url = await server(startModernHttpServer);

      const { connection, skillListings } = track(
        connectFixture(dir, { url, protocol })
      );

      await connection.getClient();

      expect(connection.era).toBe(era);
      expect(skillListings).toStrictEqual([[greetUri]]);

      const [listed] = connection.skills;

      const skill = await connection.readSkill(listed!);

      expect(skill).toMatchObject({
        uri: greetUri,
        verified: true,
        frontmatter: { name: "greet", description: "Greet people" },
        body: "Greet in the tone of refs/tone.md.\n",
      });
      await expect(
        connection.readSkill(listed!, "refs/tone.md")
      ).resolves.toMatchObject({ text: "Warm.", verified: true });

      await connection.callTool("edit-skill", { tone: "Cool." }, {});

      await expect(
        connection.readSkill(listed!, "refs/tone.md")
      ).resolves.toMatchObject({ text: "Cool.", verified: true });
      expect(toneDigest(connection.skills[0])).toBe(sha256("Cool."));
      expect(skillListings).toHaveLength(2);

      await expect(
        connection.readSkill(listed!, "refs/missing.md")
      ).rejects.toBeInstanceOf(SkillVerificationError);
    }
  );

  it("has no skills on a server without the extension", async () => {
    const dir = directory();
    const url = await server(startLegacyHttpServer);
    const { connection, skillListings } = track(connectFixture(dir, { url }));

    await connection.getClient();

    expect(connection.skills).toStrictEqual([]);
    expect(connection.error).toBeUndefined();
    expect(skillListings).toStrictEqual([[]]);
  });
});
